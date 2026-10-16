"""
AgriOpt Backend - FastAPI service for crop recommendation predictions.
"""
import binascii
import base64
from functools import lru_cache
import json
import logging
import os
import re
import urllib.error
import urllib.request
from threading import Lock
from typing import Literal

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Load keys from a ".env" file sitting next to this file (optional, no extra packages needed).
# Put all settings there (keys, provider order, model names). See the .env template.
_env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env_path):
    with open(_env_path, encoding="utf-8") as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                # Values in .env win over anything set earlier in the terminal.
                os.environ[_k.strip()] = _v.strip().strip('"').strip("'")

MODEL_DIR = os.path.join(os.path.dirname(__file__), "model")

app = FastAPI(
    title="AgriOpt API",
    description="Recommends crops, explains soil and disease observations, and provides crop-specific soil guidance.",
    version="1.0.0",
)

# Allow the frontend (served from any local dev port / static file) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Load model artifacts once at startup ---
model = joblib.load(os.path.join(MODEL_DIR, "crop_model.joblib"))
scaler = joblib.load(os.path.join(MODEL_DIR, "scaler.joblib"))
with open(os.path.join(MODEL_DIR, "model_metadata.json")) as f:
    metadata = json.load(f)

FEATURES = metadata["features"]
CLASSES = metadata["classes"]
crop_shap_explainer = None
crop_shap_background_size = 0
crop_shap_lock = Lock()

# Reasonable real-world ranges, used only for the suitability/optimization advice below.
FEATURE_RANGES = {
    "N": (0, 140),
    "P": (5, 145),
    "K": (5, 205),
    "temperature": (8, 44),
    "humidity": (14, 100),
    "ph": (3.5, 10),
    "rainfall": (20, 300),
}


class CropInput(BaseModel):
    N: float = Field(..., ge=0, description="Nitrogen content in soil (kg/ha)")
    P: float = Field(..., ge=0, description="Phosphorus content in soil (kg/ha)")
    K: float = Field(..., ge=0, description="Potassium content in soil (kg/ha)")
    temperature: float = Field(..., description="Temperature in Celsius")
    humidity: float = Field(..., ge=0, le=100, description="Relative humidity (%)")
    ph: float = Field(..., ge=0, le=14, description="Soil pH")
    rainfall: float = Field(..., ge=0, description="Rainfall in mm")


class TopPrediction(BaseModel):
    crop: str
    confidence: float


class PredictionResponse(BaseModel):
    best_crop: str
    confidence: float
    top_3: list[TopPrediction]


@app.get("/")
def root():
    return {"status": "AgriOpt API is running", "model": metadata["model_type"]}


@app.get("/api/model-info")
def model_info():
    return metadata


@app.post("/api/predict", response_model=PredictionResponse)
def predict(payload: CropInput):
    row = pd.DataFrame([[getattr(payload, f) for f in FEATURES]], columns=FEATURES)
    scaled = scaler.transform(row)

    try:
        probs = model.predict_proba(scaled)[0]
    except AttributeError:
        raise HTTPException(status_code=500, detail="Model does not support probability output.")

    order = np.argsort(probs)[::-1]
    top3 = [
        TopPrediction(crop=model.classes_[i], confidence=round(float(probs[i]) * 100, 2))
        for i in order[:3]
    ]

    return PredictionResponse(
        best_crop=top3[0].crop,
        confidence=top3[0].confidence,
        top_3=top3,
    )


class CropExplanationRequest(CropInput):
    crop: str


def _get_crop_shap_explainer():
    global crop_shap_explainer, crop_shap_background_size
    if crop_shap_explainer is None:
        with crop_shap_lock:
            if crop_shap_explainer is None:
                fitted_knn = getattr(model, "named_estimators_", {}).get("knn")
                training_rows = getattr(fitted_knn, "_fit_X", None)
                if training_rows is None or len(training_rows) == 0:
                    raise HTTPException(
                        status_code=500,
                        detail="The trained model does not expose reference samples for SHAP explanations.",
                    )
                indices = np.linspace(0, len(training_rows) - 1, min(20, len(training_rows)), dtype=int)
                background = np.asarray(training_rows)[indices]
                crop_shap_explainer = shap.KernelExplainer(model.predict_proba, background)
                crop_shap_background_size = len(background)
    return crop_shap_explainer


@app.post("/api/predict/explain")
def explain_prediction(payload: CropExplanationRequest):
    if payload.crop not in CLASSES:
        raise HTTPException(status_code=400, detail=f"Unknown crop '{payload.crop}'. Valid crops: {CLASSES}")

    row = pd.DataFrame([[getattr(payload, feature) for feature in FEATURES]], columns=FEATURES)
    scaled = scaler.transform(row)
    probabilities = model.predict_proba(scaled)[0]
    class_index = list(model.classes_).index(payload.crop)

    explainer = _get_crop_shap_explainer()
    raw_values = explainer.shap_values(scaled, nsamples=2 ** len(FEATURES), l1_reg=0, silent=True)
    if isinstance(raw_values, list):
        contributions = np.asarray(raw_values[class_index])[0]
    else:
        values = np.asarray(raw_values)
        if values.ndim != 3 or values.shape[0] != 1:
            raise HTTPException(status_code=500, detail="SHAP returned an unexpected explanation shape.")
        contributions = values[0, :, class_index]

    base_values = np.asarray(explainer.expected_value)
    baseline = float(base_values[class_index] if base_values.ndim else base_values)
    confidence = float(probabilities[class_index])
    if not np.isfinite(contributions).all() or not np.isfinite(baseline) or not np.isfinite(confidence):
        raise HTTPException(status_code=500, detail="SHAP returned non-finite explanation values.")

    return {
        "crop": payload.crop,
        "confidence_percent": round(confidence * 100, 4),
        "baseline_percent": round(baseline * 100, 4),
        "features": [
            {
                "name": feature,
                "value": float(getattr(payload, feature)),
                "shap_value": round(float(contribution), 8),
                "impact_percentage_points": round(float(contribution) * 100, 6),
            }
            for feature, contribution in zip(FEATURES, contributions)
        ],
        "explainer": "Kernel SHAP",
        "output": "Model predicted probability for the selected crop",
        "background_size": crop_shap_background_size,
        "nsamples": 2 ** len(FEATURES),
    }


class SuitabilityRequest(CropInput):
    crop: str


class SuitabilityResponse(BaseModel):
    crop: str
    verdict: str
    reasons: list[str]


@app.post("/api/predict/suitability", response_model=SuitabilityResponse)
def check_suitability(payload: SuitabilityRequest):
    if payload.crop not in CLASSES:
        raise HTTPException(status_code=400, detail=f"Unknown crop '{payload.crop}'. Valid crops: {CLASSES}")

    row = pd.DataFrame([[getattr(payload, f) for f in FEATURES]], columns=FEATURES)
    scaled = scaler.transform(row)
    probs = model.predict_proba(scaled)[0]
    crop_index = list(model.classes_).index(payload.crop)
    crop_confidence = float(probs[crop_index]) * 100

    if crop_confidence >= 15:
        verdict = "Suitable"
    elif crop_confidence >= 5:
        verdict = "Partially Suitable"
    else:
        verdict = "Not Suitable"

    reasons = [
        f"Model confidence for {payload.crop} given these conditions: {crop_confidence:.1f}%.",
    ]
    top_pred_index = int(np.argmax(probs))
    top_pred = model.classes_[top_pred_index]
    if top_pred != payload.crop:
        reasons.append(f"These conditions more strongly match '{top_pred}' ({probs[top_pred_index]*100:.1f}% confidence).")

    return SuitabilityResponse(crop=payload.crop, verdict=verdict, reasons=reasons)


# ---------------------------------------------------------------------------
# Crop disease diagnosis and treatment
# Uses free vision APIs. Providers are tried in order; if one is overloaded,
# rate-limited or fails, the next one is used automatically.
#
# Set one or both keys before starting the server (PowerShell):
#   $env:GROQ_API_KEY="your-groq-key"        # https://console.groq.com/keys
#   $env:GEMINI_API_KEY="your-gemini-key"    # https://aistudio.google.com/apikey
#   $env:OPENROUTER_API_KEY="your-openrouter-key"  # https://openrouter.ai/keys
#
# Optional:
#   $env:AI_PROVIDER_ORDER="groq,gemini,openrouter" (default; first provider is tried immediately)
#   $env:GROQ_VISION_MODELS="qwen/qwen3.8-27b"  (comma-separated fallback models)
#   $env:GROQ_TEXT_MODEL="qwen/qwen3.8-27b"
#   $env:GEMINI_MODEL="gemini-flash-latest"
#   $env:OPENROUTER_MODEL="openrouter/model-name"
#   $env:OPENROUTER_VISION_MODEL="openrouter/vision-model-name"
# ---------------------------------------------------------------------------
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini"
DEFAULT_OPENROUTER_VISION_MODEL = "google/gemini-2.5-flash"
DEFAULT_AI_PROVIDER_ORDER = "groq,gemini,openrouter"
AI_PROVIDER_TIMEOUT_SECONDS = 15
USER_AGENT = "AgriOpt/1.0"
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_B64_CHARS = 8_000_000  # roughly 6 MB of image data

DISEASE_PROMPT = """You are an expert crop pathologist helping farmers diagnose crop diseases.
The farmer selected this crop: {selected_crop}.
The farmer selected this plant part: {plant_part}.
Look closely at the attached photo of that crop and part. The photo may show a leaf, fruit/yield, flower, stem/branch, root, or whole plant.

First decide whether the image shows the selected crop. Set "matches_selected_crop" to false if it shows another crop or you cannot identify a reliable match. When it does not match, do not diagnose it or recommend medication.
Identify visible symptoms and give the most likely disease or pest only when supported by the image. Distinguish infectious disease or pest damage from nutrient deficiency, physiological stress, healthy tissue, and an unclear diagnosis. Never claim certainty from an image. If confidence is low, or the cause cannot be distinguished reliably, do not recommend any medication; explain that an expert or lab diagnosis is needed.
When a disease or pest diagnosis is sufficiently supported, suggest crop-appropriate medication options by generic active ingredient or product type and explain what each targets. Do not invent brand names, registrations, or product availability. Do not give doses, concentrations, mixing instructions, or application schedules. Tell the farmer to confirm that the product is registered for this crop and problem locally and to follow its label. For nutrient deficiency or non-infectious stress, do not recommend pesticides or fungicides.

Reply with ONLY a JSON object using exactly these keys:
{
  "is_plant": true or false (false if the photo does not show a plant, leaf, fruit or crop),
  "matches_selected_crop": true or false,
  "plant": "common name of the plant, or 'Unknown'",
  "plant_part": "the visible crop part",
  "healthy": true or false,
  "diagnosis_type": "disease" | "pest" | "nutrient_deficiency" | "physiological" | "unknown",
  "disease": "name of the most likely disease, pest, deficiency or problem, or null if healthy",
  "confidence": "low" | "medium" | "high",
  "symptoms": ["visible symptoms you can actually see in the photo"],
  "cause": "one or two sentences on the likely cause, or explain why it is uncertain",
  "medications": [
    {
      "product_or_active_ingredient": "generic active ingredient or product type, not a brand",
      "reason": "what disease or pest it may target",
      "cautions": "confirm local crop/problem registration and follow the product label; no dose"
    }
  ],
  "treatment": {
    "organic": ["organic or low-toxicity remedies"],
    "chemical": [],
    "cultural": ["practical steps such as pruning, spacing, watering changes, removing infected parts"]
  },
  "prevention": ["how to prevent it coming back"],
  "notes": "anything the user should know, e.g. if the photo is unclear or a second opinion is wise"
}
If the plant is healthy, use empty medication and treatment lists and give general care tips under prevention.
If the photo is too blurry or unclear to judge, say so in notes and set confidence to "low" with diagnosis_type "unknown".
Only describe what is visible. Do not invent symptoms or promise a treatment will stop the disease."""


class DiseaseRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 image data, without the data: prefix")
    mime_type: str = "image/jpeg"
    crop: str = Field(..., min_length=1, description="Selected crop from the recommendation model")
    plant_part: Literal["leaf", "fruit", "flower", "stem", "root", "whole plant", "other"]


def _disease_prompt(payload: DiseaseRequest) -> str:
    return DISEASE_PROMPT.replace("{selected_crop}", payload.crop).replace("{plant_part}", payload.plant_part)


class ProviderError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _as_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _as_medications(value) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    medications = []
    for item in value:
        if not isinstance(item, dict):
            continue
        product = str(item.get("product_or_active_ingredient") or "").strip()
        if not product:
            continue
        medications.append({
            "product_or_active_ingredient": product,
            "reason": str(item.get("reason") or "").strip(),
            "cautions": str(item.get("cautions") or "").strip()
            or "Confirm local approval for this crop and problem, then follow the product label exactly.",
        })
    return medications


def _extract_json(text: str) -> dict:
    """Pull the JSON object out of a model reply (ignores <think> blocks and code fences)."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(text[start:end + 1])


def _short(message: str) -> str:
    """Boil a provider's JSON error body down to its human-readable message."""
    try:
        err = json.loads(message).get("error", {})
        message = err.get("message", message) if isinstance(err, dict) else str(err)
    except (ValueError, AttributeError):
        pass
    return message[:160]


def _post_json(url: str, headers: dict, body: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=AI_PROVIDER_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")[:300]
        raise ProviderError(e.code, detail)
    except (urllib.error.URLError, TimeoutError):
        raise ProviderError(0, "Could not reach the AI service. Check your internet connection.")


def _ask_groq(model: str, key: str, payload: DiseaseRequest) -> dict:
    data = _post_json(
        GROQ_URL,
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _disease_prompt(payload)},
                    {"type": "image_url",
                     "image_url": {"url": f"data:{payload.mime_type};base64,{payload.image_base64}"}},
                ],
            }],
            "temperature": 0.2,
            "max_completion_tokens": 1400,
            "response_format": {"type": "json_object"},
        },
    )
    try:
        return _extract_json(data["choices"][0]["message"]["content"] or "")
    except (KeyError, IndexError, ValueError):
        raise ProviderError(502, "Groq returned an unreadable answer.")


def _ask_gemini(model: str, key: str, payload: DiseaseRequest) -> dict:
    data = _post_json(
        GEMINI_URL.format(model=model),
        {"x-goog-api-key": key},
        {
            "contents": [{"parts": [
                {"text": _disease_prompt(payload)},
                {"inline_data": {"mime_type": payload.mime_type, "data": payload.image_base64}},
            ]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        },
    )
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return _extract_json("".join(p.get("text", "") for p in parts if not p.get("thought")))
    except (KeyError, IndexError, ValueError):
        raise ProviderError(502, "Gemini returned an unreadable answer.")


def _ask_openrouter(model: str, key: str, payload: DiseaseRequest) -> dict:
    data = _post_json(
        OPENROUTER_URL,
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": _disease_prompt(payload)},
                    {"type": "image_url",
                     "image_url": {"url": f"data:{payload.mime_type};base64,{payload.image_base64}"}},
                ],
            }],
            "temperature": 0.2,
            "max_tokens": 1400,
            "response_format": {"type": "json_object"},
        },
    )
    try:
        return _extract_json(data["choices"][0]["message"]["content"] or "")
    except (KeyError, IndexError, ValueError):
        raise ProviderError(502, "OpenRouter returned an unreadable answer.")


def _run_with_fallback(
    gemini_fn,
    groq_fn,
    openrouter_fn,
    groq_key: str,
    gemini_key: str,
    openrouter_key: str,
    arg,
    *,
    groq_model_env: str = "GROQ_TEXT_MODEL",
    openrouter_model_env: str = "OPENROUTER_MODEL",
    openrouter_default_model: str = DEFAULT_OPENROUTER_MODEL,
):
    """Try the preferred provider first, then fail over quickly to the other provider."""
    order_value = (
        os.environ.get("AI_PROVIDER_ORDER", "").strip()
        or os.environ.get("DISEASE_PROVIDER_ORDER", "").strip()
        or DEFAULT_AI_PROVIDER_ORDER
    )
    order = [provider.strip().lower() for provider in order_value.split(",") if provider.strip()]
    if not order:
        order = DEFAULT_AI_PROVIDER_ORDER.split(",")
    if openrouter_key and "openrouter" not in order:
        order.append("openrouter")
    attempts = []
    for provider in order:
        if provider == "gemini":
            if gemini_key:
                attempts.append(("Gemini", os.environ.get("GEMINI_MODEL", "gemini-flash-latest"), gemini_key, gemini_fn))
        elif provider == "groq":
            if groq_key:
                models = []
                for m in os.environ.get(groq_model_env, "").split(",") + [DEFAULT_GROQ_MODEL]:
                    m = m.strip()
                    if m and m not in models:
                        models.append(m)
                attempts += [("Groq", m, groq_key, groq_fn) for m in models]
        elif provider == "openrouter":
            if openrouter_key:
                model = os.environ.get(openrouter_model_env, "").strip() or openrouter_default_model
                attempts.append(("OpenRouter", model, openrouter_key, openrouter_fn))

    errors = []
    for name, model, key, ask in attempts:
        try:
            return ask(model, key, arg)
        except ProviderError as e:
            logger.warning("AI provider %s model %s failed (HTTP %s): %s", name, model, e.status, _short(e.message))
            errors.append((name, model, e))

    if errors and all(e.status == 429 for _, _, e in errors):
        raise HTTPException(
            status_code=429,
            detail="AI providers are rate-limited right now. Wait briefly and retry; if it continues, check your provider quota or configure another available model.",
        )
    if errors:
        raise HTTPException(
            status_code=503,
            detail="AI providers are temporarily unavailable. The app tried its configured fallback; please retry shortly. If this continues, check provider keys, model access, and quotas.",
        )
    raise HTTPException(
        status_code=503,
        detail="No AI provider is configured. Add a Groq, Gemini, or OpenRouter API key and model to the backend .env file, then restart the server.",
    )


@app.post("/api/disease/detect")
def detect_disease(payload: DiseaseRequest):
    if payload.crop not in CLASSES:
        raise HTTPException(status_code=400, detail=f"Unknown crop '{payload.crop}'. Valid crops: {CLASSES}")
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not groq_key and not gemini_key and not openrouter_key:
        raise HTTPException(
            status_code=503,
            detail="No AI key is set on the server. Configure GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY before starting uvicorn.",
        )
    if payload.mime_type not in ALLOWED_MIME:
        raise HTTPException(status_code=400, detail="Please upload a JPG, PNG or WebP image.")
    if len(payload.image_base64) > MAX_IMAGE_B64_CHARS:
        raise HTTPException(status_code=413, detail="Image is too large. Try a smaller photo.")
    try:
        base64.b64decode(payload.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Image data is not valid base64.")

    result = _run_with_fallback(
        _ask_gemini,
        _ask_groq,
        _ask_openrouter,
        groq_key,
        gemini_key,
        openrouter_key,
        payload,
        groq_model_env="GROQ_VISION_MODELS",
        openrouter_model_env="OPENROUTER_VISION_MODEL",
        openrouter_default_model=DEFAULT_OPENROUTER_VISION_MODEL,
    )

    treatment = result.get("treatment") if isinstance(result.get("treatment"), dict) else {}
    diagnosis_type = str(result.get("diagnosis_type") or "unknown").lower()
    if diagnosis_type not in {"disease", "pest", "nutrient_deficiency", "physiological", "unknown"}:
        diagnosis_type = "unknown"
    confidence = str(result.get("confidence") or "low").lower()
    if confidence not in {"low", "medium", "high"}:
        confidence = "low"
    healthy = bool(result.get("healthy", False))
    medications = _as_medications(result.get("medications"))
    if (
        healthy
        or not bool(result.get("is_plant", True))
        or not bool(result.get("matches_selected_crop", False))
        or diagnosis_type not in {"disease", "pest"}
        or confidence == "low"
    ):
        medications = []
    return {
        "is_plant": bool(result.get("is_plant", True)),
        "matches_selected_crop": bool(result.get("matches_selected_crop", False)),
        "selected_crop": payload.crop,
        "plant": str(result.get("plant") or "Unknown"),
        "plant_part": str(result.get("plant_part") or payload.plant_part),
        "healthy": healthy,
        "diagnosis_type": diagnosis_type,
        "disease": result.get("disease") or None,
        "confidence": confidence,
        "symptoms": _as_list(result.get("symptoms")),
        "cause": str(result.get("cause") or ""),
        "medications": medications,
        "treatment": {
            "organic": _as_list(treatment.get("organic")),
            "chemical": [],
            "cultural": _as_list(treatment.get("cultural")),
        },
        "prevention": _as_list(result.get("prevention")),
        "notes": str(result.get("notes") or ""),
    }


# ---------------------------------------------------------------------------
# AI assistant ("Sprout") - chat that can see what the farmer is doing on the site
# ---------------------------------------------------------------------------
ASSISTANT_PROMPT = """You are Sprout, a friendly, cute and patient farming assistant living inside the AgriOpt website. You help farmers, many of whom are not tech-savvy, so use simple, warm language.

The website has six pages (shown in the left menu):
1. Home: a short introduction.
2. Crop recommendation: the farmer sets 7 sliders (nitrogen N, phosphorus P, potassium K in kg/ha, temperature in C, humidity %, soil pH, rainfall in mm). An AI model recommends the best of 22 crops (apple, banana, blackgram, chickpea, coconut, coffee, cotton, grapes, jute, kidneybeans, lentil, maize, mango, mothbeans, mungbean, muskmelon, orange, papaya, pigeonpeas, pomegranate, rice, watermelon), shows the top 3 with confidence, and can check how suitable a chosen crop is.
3. Soil profile and crop-specific improvement: the farmer enters NPK and pH values, optionally reports known soil texture, chooses a crop, and receives an AI interpretation and cautious amendment suggestions.
4. Why this recommendation?: SHAP explains how each soil and climate reading raises or lowers the recommended crop's model confidence compared with a reference baseline.
5. Crop disease detection & treatment: the farmer selects one of the supported crops and the crop part, then uploads a photo. AI checks whether the photo matches and, when a disease or pest diagnosis is sufficiently supported, suggests crop-appropriate medication options and safe next steps.
6. Dataset info & credits: describes the Kaggle Crop Recommendation Dataset (2,200 rows, 8 columns, credited to eonyushi) and clarifies that crop disease results come from AI image analysis, with no separate disease image dataset credit documented in the project.

You can see what the farmer is doing through the SITE CONTEXT JSON below: the current page, the slider values, the latest crop recommendation, soil analysis readings and result, its SHAP explanation, the latest suitability check and the latest crop disease result. Use it when it helps: explain results in simple words, suggest what to try next (for example change a slider or upload another photo) and point to the right page by its menu name. If something is not in the context, say you cannot see it yet and explain how to get it. Never invent results.

Rules:
- Reply in the same language the farmer writes in.
- Keep answers short: usually 2 to 6 short sentences or a few lines starting with "-". Plain text only, no markdown symbols such as ** or #.
- Stay on farming (crops, soil, fertiliser, irrigation, pests, diseases, weather) and using this website. Gently steer other topics back.
- You are an AI, not an agronomist. For serious crop loss or fast-spreading disease, suggest visiting the local agricultural extension office.
- For crop medications/pesticides: prefer cultural and low-toxicity methods where appropriate, never give exact doses (tell them to follow the product label), and remind them to confirm local registration, use protective gear, and keep chemicals away from children and food."""


class ChatMessage(BaseModel):
    role: str
    content: str = Field(..., max_length=2000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1, max_length=60)
    context: dict = {}


class ChatJob:
    """What the provider functions receive: system text + cleaned message list."""
    def __init__(self, system: str, messages: list[dict]):
        self.system = system
        self.messages = messages


def _chat_gemini(model: str, key: str, job: ChatJob) -> str:
    data = _post_json(
        GEMINI_URL.format(model=model),
        {"x-goog-api-key": key},
        {
            "systemInstruction": {"parts": [{"text": job.system}]},
            "contents": [
                {"role": "user" if m["role"] == "user" else "model", "parts": [{"text": m["content"]}]}
                for m in job.messages
            ],
            "generationConfig": {"temperature": 0.6, "maxOutputTokens": 2048},
        },
    )
    try:
        parts = data["candidates"][0]["content"]["parts"]
        text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
    except (KeyError, IndexError):
        text = ""
    if not text:
        raise ProviderError(502, "Gemini returned an empty answer.")
    return text


def _chat_groq(model: str, key: str, job: ChatJob) -> str:
    data = _post_json(
        GROQ_URL,
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "messages": [{"role": "system", "content": job.system}] + job.messages,
            "temperature": 0.6,
            "max_tokens": 1200,
        },
    )
    try:
        text = re.sub(r"<think>.*?</think>", "", data["choices"][0]["message"]["content"] or "", flags=re.S).strip()
    except (KeyError, IndexError):
        text = ""
    if not text:
        raise ProviderError(502, "Groq returned an empty answer.")
    return text


def _chat_openrouter(model: str, key: str, job: ChatJob) -> str:
    data = _post_json(
        OPENROUTER_URL,
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "messages": [{"role": "system", "content": job.system}] + job.messages,
            "temperature": 0.6,
            "max_tokens": 1200,
        },
    )
    try:
        text = re.sub(r"<think>.*?</think>", "", data["choices"][0]["message"]["content"] or "", flags=re.S).strip()
    except (KeyError, IndexError):
        text = ""
    if not text:
        raise ProviderError(502, "OpenRouter returned an empty answer.")
    return text


@app.post("/api/assistant/chat")
def assistant_chat(payload: ChatRequest):
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not groq_key and not gemini_key and not openrouter_key:
        raise HTTPException(status_code=503, detail="No AI key is set on the server. Add GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY to the .env file and restart uvicorn.")

    # Keep the last 12 turns, starting with a user message.
    msgs = [{"role": "user" if m.role == "user" else "assistant", "content": m.content}
            for m in payload.messages[-12:] if m.content.strip()]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if not msgs or msgs[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Please send a message.")

    context_text = json.dumps(payload.context, ensure_ascii=False, default=str)[:6000]
    job = ChatJob(f"{ASSISTANT_PROMPT}\n\nSITE CONTEXT (JSON):\n{context_text}", msgs)
    return {"reply": _run_with_fallback(
        _chat_gemini,
        _chat_groq,
        _chat_openrouter,
        groq_key,
        gemini_key,
        openrouter_key,
        job,
    )}


class SoilAdviceRequest(BaseModel):
    crop: str
    N: float = Field(..., ge=0, description="Soil nitrogen value, as entered, in kg/ha")
    P: float = Field(..., ge=0, description="Soil phosphorus value, as entered, in kg/ha")
    K: float = Field(..., ge=0, description="Soil potassium value, as entered, in kg/ha")
    temperature: float | None = Field(None, description="Optional local temperature in Celsius")
    humidity: float | None = Field(None, ge=0, le=100, description="Optional local relative humidity (%)")
    ph: float = Field(..., ge=0, le=14, description="Soil pH")
    rainfall: float | None = Field(None, ge=0, description="Optional local rainfall in mm")
    texture: Literal["unknown", "sandy", "loamy", "silty", "clayey"] = "unknown"


class SoilNutrientStatus(BaseModel):
    nutrient: str
    status: str
    explanation: str


class SoilAmendment(BaseModel):
    supplement: str
    category: str
    purpose: str
    caution: str


class SoilAdviceResponse(BaseModel):
    crop: str
    readings: dict
    analysis_source: Literal["ai", "local_fallback"] = "ai"
    analysis_notice: str | None = None
    soil_classification: str
    summary: str
    crop_fit: str
    nutrient_status: list[SoilNutrientStatus]
    recommendations: list[SoilAmendment]
    practices: list[str]
    uncertainties: str


@lru_cache(maxsize=32)
def _crop_training_ranges(crop: str) -> dict[str, tuple[float, float]]:
    """Get central reference ranges from the crop recommendation model's training samples."""
    estimator = getattr(model, "named_estimators_", {}).get("knn")
    training_rows = getattr(estimator, "_fit_X", None)
    training_labels = getattr(estimator, "_y", None)
    if training_rows is None or training_labels is None:
        return {}
    try:
        class_index = list(model.classes_).index(crop)
        rows = scaler.inverse_transform(np.asarray(training_rows))
        labels = np.asarray(training_labels).reshape(-1)
        crop_rows = rows[labels == class_index]
        if len(crop_rows) == 0:
            return {}
        low, high = np.percentile(crop_rows, [10, 90], axis=0)
        return {
            feature: (float(low[index]), float(high[index]))
            for index, feature in enumerate(FEATURES)
        }
    except (AttributeError, IndexError, TypeError, ValueError):
        logger.exception("Could not derive local crop reference ranges for %s", crop)
        return {}


def _local_soil_advice(payload: SoilAdviceRequest, readings: dict) -> SoilAdviceResponse:
    """Return useful, cautious guidance from local training references if AI services fail."""
    ranges = _crop_training_ranges(payload.crop)
    measured = ("N", "P", "K", "ph")
    status_rows = []
    outside = []
    for feature in measured:
        label = "pH" if feature == "ph" else feature
        reference = ranges.get(feature)
        if reference is None:
            status_rows.append(SoilNutrientStatus(
                nutrient=label,
                status="Not compared",
                explanation="A reliable crop-specific reference range is not available locally; use a current soil test.",
            ))
            continue
        low, high = reference
        value = readings[feature]
        if value < low:
            status = "Below the model's central training range"
            outside.append((feature, "below"))
        elif value > high:
            status = "Above the model's central training range"
            outside.append((feature, "above"))
        else:
            status = "Within the model's central training range"
        status_rows.append(SoilNutrientStatus(
            nutrient=label,
            status=status,
            explanation=(
                f"Reported value {value:g}; the central 80% of {payload.crop} training samples "
                f"were {low:.2f}–{high:.2f}. This is a model-data comparison, not a diagnosis "
                "of deficiency or an agronomic target."
            ),
        ))

    if payload.texture == "unknown":
        classification = "NPK and pH readings recorded; soil texture unknown"
        texture_text = "Soil texture was not provided and cannot be inferred from NPK and pH."
    else:
        classification = f"{payload.texture.capitalize()} texture reported by user"
        texture_text = f"The {payload.texture} texture is user-reported, not verified by these readings."

    summary = (
        f"Your sample reports N {payload.N:g}, P {payload.P:g}, K {payload.K:g} and pH {payload.ph:g}. "
        f"{texture_text} Nutrient readings are compared with this crop's model training samples only; "
        "the dataset ranges are not fertilizer targets."
    )
    if ranges:
        comparison_features = [feature for feature in FEATURES if feature in ranges and readings.get(feature) is not None]
        compared_count = sum(
            ranges[feature][0] <= readings[feature] <= ranges[feature][1]
            for feature in comparison_features
        )
        crop_fit = (
            f"{compared_count} of {len(comparison_features)} reported readings fall within the central "
            f"training-sample ranges for {payload.crop}. This describes similarity to examples seen by "
            "the crop model, not a prediction of yield or a guarantee of crop suitability."
        )
    else:
        crop_fit = (
            f"The local model could not provide a reference profile for {payload.crop}. "
            "Use a local soil test and crop-specific guidance before making changes."
        )

    recommendations = [
        SoilAmendment(
            supplement="Soil-test-guided nutrient amendment",
            category="Nutrient management",
            purpose="Ask a qualified local adviser to interpret any values outside the crop model's training range and identify whether a nutrient amendment is actually needed.",
            caution="Training ranges are not deficiency thresholds. Confirm with a current laboratory soil test before applying fertilizer.",
        ),
        SoilAmendment(
            supplement="Mature compost or other locally approved organic matter",
            category="Soil structure and organic matter",
            purpose="May support soil structure and water retention when appropriate for the field and crop.",
            caution="Use only clean, mature material and follow local guidance; it is not a substitute for a nutrient test.",
        ),
    ]
    if any(feature == "ph" for feature, _ in outside):
        recommendations.insert(0, SoilAmendment(
            supplement="Locally recommended pH amendment, if confirmed",
            category="Soil pH management",
            purpose="A pH value outside the model's central training range is a reason to verify soil pH and ask whether correction is appropriate for this crop.",
            caution="Do not select a liming or acidifying product from the model range alone; confirm with a soil test and local agronomist.",
        ))

    practices = [
        "Use a recent laboratory soil test with locally calibrated units and recommendations.",
        "Add crop residues or suitable cover crops where practical, while managing disease and nutrient needs.",
        "Retest after amendments and avoid applying nutrients that the soil test does not call for.",
    ]
    climate_comparisons = []
    for feature in ("temperature", "humidity", "rainfall"):
        value = readings.get(feature)
        reference = ranges.get(feature)
        if value is None or reference is None:
            continue
        low, high = reference
        if value < low or value > high:
            climate_comparisons.append(f"{feature} is outside the model's central crop training range")
    if climate_comparisons:
        crop_fit += " " + "; ".join(climate_comparisons) + ". Climate values describe context, not soil condition."

    return SoilAdviceResponse(
        crop=payload.crop,
        readings=readings,
        analysis_source="local_fallback",
        analysis_notice=(
            "AI services are temporarily unavailable or rate-limited. This local fallback compares your values "
            "with the crop recommendation model's training samples; it is not an AI diagnosis or a fertilizer prescription."
        ),
        soil_classification=classification,
        summary=summary,
        crop_fit=crop_fit,
        nutrient_status=status_rows,
        recommendations=recommendations[:5],
        practices=practices,
        uncertainties=(
            "The crop recommendation dataset records example conditions, not validated soil-test thresholds. "
            "This check cannot diagnose nutrient deficiency or measure salinity, organic matter, micronutrients, "
            "drainage, contamination, or soil biology. Confirm with a local laboratory or agronomist before "
            "making substantial changes, and follow local product labels and regulations."
        ),
    )


def _ask_soil_gemini(model_name: str, key: str, job: ChatJob) -> dict:
    try:
        return _extract_json(_chat_gemini(model_name, key, job))
    except (ValueError, json.JSONDecodeError):
        raise ProviderError(502, "Gemini returned an unreadable soil analysis.")


def _ask_soil_groq(model_name: str, key: str, job: ChatJob) -> dict:
    try:
        return _extract_json(_chat_groq(model_name, key, job))
    except (ValueError, json.JSONDecodeError):
        raise ProviderError(502, "Groq returned an unreadable soil analysis.")


def _ask_soil_openrouter(model_name: str, key: str, job: ChatJob) -> dict:
    try:
        return _extract_json(_chat_openrouter(model_name, key, job))
    except (ValueError, json.JSONDecodeError):
        raise ProviderError(502, "OpenRouter returned an unreadable soil analysis.")


@app.post("/api/soil/advice", response_model=SoilAdviceResponse)
def soil_advice(payload: SoilAdviceRequest):
    if payload.crop not in CLASSES:
        raise HTTPException(status_code=400, detail=f"Unknown crop '{payload.crop}'. Valid crops: {CLASSES}")

    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip()

    readings = {
        "N": payload.N,
        "P": payload.P,
        "K": payload.K,
        "temperature": payload.temperature,
        "humidity": payload.humidity,
        "ph": payload.ph,
        "rainfall": payload.rainfall,
        "texture": payload.texture,
    }
    prompt = f"""Analyze these soil-test readings and local climate context for the selected crop. Respond with one JSON object only, with exactly these keys:
soil_classification (short descriptive phrase), summary (plain-language measured soil profile), crop_fit (how suitable the reported profile appears for the crop and what matters most), nutrient_status (array of objects with nutrient, status, explanation for N, P and K), recommendations (array of up to 5 objects with supplement, category, purpose, caution), practices (array of 2 to 5 practical soil-care steps), uncertainties (what this sample cannot establish and what to test or confirm next).

Selected crop: {payload.crop}
Reported soil readings: {json.dumps(readings)}

Use the provided texture only as user-reported information. If texture is unknown, do not infer or claim a physical soil type from NPK and pH. Treat temperature, humidity and rainfall as optional local crop context, never as soil properties; if any are null, do not infer or mention them. Do not claim a nutrient deficiency or prescribe a product/dose as certain based on these values alone; explain uncertainty, local soil-test methods, units and crop stage matter. Suggest amendment or supplement types only when relevant, give a clear reason and an appropriate caution. Never give exact rates, medication doses, product brands, or chemical mixing instructions. Do not claim these readings cover salinity, organic matter, micronutrients, drainage, contamination, or soil biology. Recommend confirming before applying amendments, following local product labels and regulations, and getting local agronomist advice for major changes."""
    job = ChatJob(
        "You are a careful agricultural soil adviser. Use cautious, practical language and return valid JSON only.",
        [{"role": "user", "content": prompt}],
    )
    try:
        result = _run_with_fallback(
            _ask_soil_gemini,
            _ask_soil_groq,
            _ask_soil_openrouter,
            groq_key,
            gemini_key,
            openrouter_key,
            job,
        )
    except HTTPException as exc:
        logger.warning("Using local soil advice because AI providers were unavailable (HTTP %s).", exc.status_code)
        return _local_soil_advice(payload, readings)

    if not isinstance(result, dict):
        logger.warning("Using local soil advice because the AI response was not a JSON object.")
        return _local_soil_advice(payload, readings)

    try:
        advice = SoilAdviceResponse(
            crop=payload.crop,
            readings=readings,
            analysis_source="ai",
            **{
                field: result[field]
                for field in (
                    "soil_classification",
                    "summary",
                    "crop_fit",
                    "nutrient_status",
                    "recommendations",
                    "practices",
                    "uncertainties",
                )
                if field in result
            },
        )
    except (TypeError, ValueError) as exc:
        logger.warning("Using local soil advice because the AI response was invalid: %s", exc)
        return _local_soil_advice(payload, readings)
    if len(advice.nutrient_status) != 3 or len(advice.recommendations) > 5 or not 2 <= len(advice.practices) <= 5:
        logger.warning("Using local soil advice because the AI response did not meet the soil report format.")
        return _local_soil_advice(payload, readings)
    return advice