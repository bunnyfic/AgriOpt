const API_BASE = "https://agri-opt-two.vercel.app/";

// What the farmer has done on each page (shared with the AI assistant)
const siteState = { crop: null, suitability: null, explanation: null, disease: null, soilAdvice: null };

// Average N/P/K/temperature/humidity/ph/rainfall per crop, computed from the training dataset.
// Used to draw the "typical conditions" polygon on the radar chart.
const CROP_PROFILES = {"rice":{"N":79.89,"P":47.58,"K":39.87,"temperature":23.69,"humidity":82.27,"ph":6.43,"rainfall":236.18},"maize":{"N":77.76,"P":48.44,"K":19.79,"temperature":22.39,"humidity":65.09,"ph":6.25,"rainfall":84.77},"chickpea":{"N":40.09,"P":67.79,"K":79.92,"temperature":18.87,"humidity":16.86,"ph":7.34,"rainfall":80.06},"kidneybeans":{"N":20.75,"P":67.54,"K":20.05,"temperature":20.11,"humidity":21.61,"ph":5.75,"rainfall":105.92},"pigeonpeas":{"N":20.73,"P":67.73,"K":20.29,"temperature":27.74,"humidity":48.06,"ph":5.79,"rainfall":149.46},"mothbeans":{"N":21.44,"P":48.01,"K":20.23,"temperature":28.19,"humidity":53.16,"ph":6.83,"rainfall":51.2},"mungbean":{"N":20.99,"P":47.28,"K":19.87,"temperature":28.53,"humidity":85.5,"ph":6.72,"rainfall":48.44},"blackgram":{"N":40.02,"P":67.47,"K":19.24,"temperature":29.97,"humidity":65.12,"ph":7.13,"rainfall":67.88},"lentil":{"N":18.77,"P":68.36,"K":19.41,"temperature":24.51,"humidity":64.8,"ph":6.93,"rainfall":45.68},"pomegranate":{"N":18.87,"P":18.75,"K":40.21,"temperature":21.84,"humidity":90.13,"ph":6.43,"rainfall":107.53},"banana":{"N":100.23,"P":82.01,"K":50.05,"temperature":27.38,"humidity":80.36,"ph":5.98,"rainfall":104.63},"mango":{"N":20.07,"P":27.18,"K":29.92,"temperature":31.21,"humidity":50.16,"ph":5.77,"rainfall":94.7},"grapes":{"N":23.18,"P":132.53,"K":200.11,"temperature":23.85,"humidity":81.87,"ph":6.03,"rainfall":69.61},"watermelon":{"N":99.42,"P":17.0,"K":50.22,"temperature":25.59,"humidity":85.16,"ph":6.5,"rainfall":50.79},"muskmelon":{"N":100.32,"P":17.72,"K":50.08,"temperature":28.66,"humidity":92.34,"ph":6.36,"rainfall":24.69},"apple":{"N":20.8,"P":134.22,"K":199.89,"temperature":22.63,"humidity":92.33,"ph":5.93,"rainfall":112.65},"orange":{"N":19.58,"P":16.55,"K":10.01,"temperature":22.77,"humidity":92.17,"ph":7.02,"rainfall":110.47},"papaya":{"N":49.88,"P":59.05,"K":50.04,"temperature":33.72,"humidity":92.4,"ph":6.74,"rainfall":142.63},"coconut":{"N":21.98,"P":16.93,"K":30.59,"temperature":27.41,"humidity":94.84,"ph":5.98,"rainfall":175.69},"cotton":{"N":117.77,"P":46.24,"K":19.56,"temperature":23.99,"humidity":79.84,"ph":6.91,"rainfall":80.4},"jute":{"N":78.4,"P":46.86,"K":39.99,"temperature":24.96,"humidity":79.64,"ph":6.73,"rainfall":174.79},"coffee":{"N":101.2,"P":28.74,"K":29.94,"temperature":25.54,"humidity":58.87,"ph":6.79,"rainfall":158.07}};

// [key, label, unit, min, max, step, default, accent]
const FIELDS = [
  ["N", "Nitrogen", "kg/ha", 0, 140, 1, 60, "clay"],
  ["P", "Phosphorus", "kg/ha", 5, 145, 1, 45, "wheat"],
  ["K", "Potassium", "kg/ha", 5, 205, 1, 45, "sprout"],
  ["temperature", "Temperature", "°C", 8, 44, 0.1, 24, "clay"],
  ["humidity", "Humidity", "%", 14, 100, 0.5, 70, "sprout"],
  ["ph", "Soil pH", "", 3.5, 10, 0.1, 6.5, "wheat"],
  ["rainfall", "Rainfall", "mm", 20, 300, 1, 120, "clay"],
];

const horizonsEl = document.getElementById("horizons");

FIELDS.forEach(([key, label, unit, min, max, step, def, accent]) => {
  const wrap = document.createElement("div");
  wrap.className = "horizon";
  wrap.innerHTML = `
    <div class="horizon-head">
      <span class="horizon-name">${label}<span class="horizon-sub">${unit}</span></span>
      <span class="horizon-value" id="val-${key}">${def}</span>
    </div>
    <div class="horizon-track">
      <div class="horizon-fill" id="fill-${key}" style="background:var(--${accent})"></div>
      <div class="horizon-ticks">${'<span></span>'.repeat(9)}</div>
      <input type="range" id="input-${key}" min="${min}" max="${max}" step="${step}" value="${def}" />
    </div>
  `;
  horizonsEl.appendChild(wrap);
});

function updateFill(key) {
  const input = document.getElementById(`input-${key}`);
  const min = parseFloat(input.min), max = parseFloat(input.max), val = parseFloat(input.value);
  const pct = ((val - min) / (max - min)) * 100;
  document.getElementById(`fill-${key}`).style.width = pct + "%";
  document.getElementById(`val-${key}`).textContent =
    Number.isInteger(parseFloat(input.step)) ? Math.round(val) : val;
}

let currentRadarCrop = null;

FIELDS.forEach(([key]) => {
  const input = document.getElementById(`input-${key}`);
  input.addEventListener("input", () => {
    updateFill(key);
    if (currentRadarCrop) drawRadarChart(currentRadarCrop);
  });
  updateFill(key);
});

function getReadings() {
  const readings = {};
  FIELDS.forEach(([key]) => {
    readings[key] = parseFloat(document.getElementById(`input-${key}`).value);
  });
  return readings;
}

// ---------- Radar chart ----------
const RADAR_CENTER = { x: 170, y: 150 };
const RADAR_RADIUS = 105;
const RADAR_LABELS = { N: "N", P: "P", K: "K", temperature: "Temp", humidity: "Humid", ph: "pH", rainfall: "Rain" };

function radarPoint(index, total, fraction) {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  const r = RADAR_RADIUS * Math.max(0, Math.min(1, fraction));
  return {
    x: RADAR_CENTER.x + r * Math.cos(angle),
    y: RADAR_CENTER.y + r * Math.sin(angle),
  };
}

function normalize(key, value) {
  const [min, max] = [FIELDS.find(f => f[0] === key)[3], FIELDS.find(f => f[0] === key)[4]];
  return (value - min) / (max - min);
}

function drawRadarChart(cropName) {
  const profile = CROP_PROFILES[cropName];
  if (!profile) return;

  const sample = getReadings();
  const keys = FIELDS.map(f => f[0]);
  const total = keys.length;
  const svg = document.getElementById("radarChart");
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  // Grid rings
  [0.25, 0.5, 0.75, 1].forEach(level => {
    const pts = keys.map((k, i) => radarPoint(i, total, level));
    const poly = document.createElementNS(ns, "polygon");
    poly.setAttribute("points", pts.map(p => `${p.x},${p.y}`).join(" "));
    poly.setAttribute("class", "radar-grid");
    svg.appendChild(poly);
  });

  // Axis lines + labels
  keys.forEach((k, i) => {
    const outer = radarPoint(i, total, 1);
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", RADAR_CENTER.x);
    line.setAttribute("y1", RADAR_CENTER.y);
    line.setAttribute("x2", outer.x);
    line.setAttribute("y2", outer.y);
    line.setAttribute("class", "radar-axis");
    svg.appendChild(line);

    const labelPos = radarPoint(i, total, 1.18);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", labelPos.x);
    text.setAttribute("y", labelPos.y);
    text.setAttribute("class", "radar-axis-label");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = RADAR_LABELS[k];
    svg.appendChild(text);
  });

  // Ideal (crop typical) polygon
  const idealPts = keys.map((k, i) => radarPoint(i, total, normalize(k, profile[k])));
  const idealPoly = document.createElementNS(ns, "polygon");
  idealPoly.setAttribute("points", idealPts.map(p => `${p.x},${p.y}`).join(" "));
  idealPoly.setAttribute("class", "radar-poly-ideal");
  svg.appendChild(idealPoly);

  // Sample polygon
  const samplePts = keys.map((k, i) => radarPoint(i, total, normalize(k, sample[k])));
  const samplePoly = document.createElementNS(ns, "polygon");
  samplePoly.setAttribute("points", samplePts.map(p => `${p.x},${p.y}`).join(" "));
  samplePoly.setAttribute("class", "radar-poly-sample");
  svg.appendChild(samplePoly);

  samplePts.forEach(p => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", p.x);
    dot.setAttribute("cy", p.y);
    dot.setAttribute("r", 3);
    dot.setAttribute("class", "radar-dot-sample");
    svg.appendChild(dot);
  });

  document.getElementById("radarCropName").textContent = cropName;
  document.getElementById("radarSection").classList.add("show");
  currentRadarCrop = cropName;
}

function showError(msg) {
  const el = document.getElementById("apiError");
  el.textContent = msg;
  el.classList.add("show");
}
function clearError() {
  document.getElementById("apiError").classList.remove("show");
}

const explainLink = document.getElementById("explainLink");
const explainButton = document.getElementById("explain-btn");
const explanationEmpty = document.getElementById("explanation-empty");
const explanationError = document.getElementById("explanation-error");
const explanationResult = document.getElementById("explanation-result");
let explanationLoading = false;

const EXPLANATION_FEATURES = {
  N: { label: "Nitrogen", unit: "kg/ha" },
  P: { label: "Phosphorus", unit: "kg/ha" },
  K: { label: "Potassium", unit: "kg/ha" },
  temperature: { label: "Temperature", unit: "°C" },
  humidity: { label: "Humidity", unit: "%" },
  ph: { label: "Soil pH", unit: "pH" },
  rainfall: { label: "Rainfall", unit: "mm" },
};

function resetExplanation() {
  siteState.explanation = null;
  explanationResult.replaceChildren();
  explanationResult.hidden = true;
  explanationError.hidden = true;
  explanationEmpty.hidden = !siteState.crop;
  explainButton.disabled = !siteState.crop || explanationLoading;
  explainLink.hidden = !siteState.crop;
}

function renderExplanation(data) {
  siteState.explanation = data;
  explanationResult.replaceChildren();

  const summary = document.createElement("div");
  summary.className = "explanation-summary";
  const title = document.createElement("h2");
  title.textContent = `${data.crop} · ${Number(data.confidence_percent).toFixed(2)}% model confidence`;
  const baseline = document.createElement("p");
  baseline.textContent =
    `Reference baseline: ${Number(data.baseline_percent).toFixed(2)}%. ` +
    `This is the average model output for ${data.crop} across ${data.background_size} reference soil and climate samples.`;
  const formula = document.createElement("p");
  formula.className = "shap-formula";
  formula.textContent =
    `${Number(data.baseline_percent).toFixed(2)}% baseline + feature contributions ≈ ` +
    `${Number(data.confidence_percent).toFixed(2)}% for this sample.`;
  summary.append(title, baseline, formula);
  explanationResult.appendChild(summary);

  const heading = document.createElement("h3");
  heading.className = "shap-list-heading";
  heading.textContent = "What moved the confidence?";
  explanationResult.appendChild(heading);

  const maxImpact = Math.max(0, ...data.features.map(feature => Math.abs(feature.impact_percentage_points)));
  const featureList = document.createElement("div");
  featureList.className = "shap-feature-list";
  [...data.features]
    .sort((a, b) => Math.abs(b.impact_percentage_points) - Math.abs(a.impact_percentage_points))
    .forEach(feature => {
      const info = EXPLANATION_FEATURES[feature.name] || { label: feature.name, unit: "" };
      const impact = Number(feature.impact_percentage_points);
      const positive = impact >= 0;
      const row = document.createElement("div");
      row.className = "shap-feature-row";

      const details = document.createElement("div");
      details.className = "shap-feature-details";
      const label = document.createElement("strong");
      label.textContent = info.label;
      const reading = document.createElement("span");
      reading.textContent = `Your reading: ${feature.value} ${info.unit}`.trim();
      details.append(label, reading);

      const track = document.createElement("div");
      track.className = "shap-track";
      track.setAttribute("aria-hidden", "true");
      const bar = document.createElement("span");
      bar.className = `shap-bar ${positive ? "positive" : "negative"}`;
      bar.style.width = `${maxImpact ? Math.abs(impact) / maxImpact * 50 : 0}%`;
      track.appendChild(bar);

      const score = document.createElement("strong");
      score.className = `shap-impact ${positive ? "positive" : "negative"}`;
      score.textContent =
        `${positive ? "+" : ""}${impact.toFixed(2)} percentage points · ` +
        (positive ? "increased" : "reduced") + " confidence";
      row.append(details, track, score);
      featureList.appendChild(row);
    });
  explanationResult.appendChild(featureList);

  const note = document.createElement("p");
  note.className = "explanation-note";
  note.textContent =
    `Method: ${data.explainer}. These contributions explain the model's predicted probability for ${data.crop}; ` +
    "they are not a guarantee of yield or proof that a crop will succeed. SHAP allocates feature effects additively, " +
    "so correlated readings and interactions may share credit.";
  explanationResult.appendChild(note);
  explanationResult.hidden = false;
  explanationEmpty.hidden = true;
  explainButton.textContent = "Refresh explanation";
}

async function explainRecommendation() {
  if (!siteState.crop || explanationLoading) return;
  const recommendation = siteState.crop;
  explanationLoading = true;
  explainButton.disabled = true;
  explainButton.textContent = "Calculating SHAP values…";
  explanationError.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/api/predict/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...recommendation.readings_used,
        crop: recommendation.best_crop,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : `API returned ${res.status}`);
    }
    if (siteState.crop !== recommendation) return;
    renderExplanation(data);
  } catch (err) {
    explanationError.textContent = err instanceof TypeError
      ? `Couldn't reach the AgriOpt API at ${API_BASE}. Make sure the backend is running.`
      : `Couldn't calculate the explanation: ${err.message}`;
    explanationError.hidden = false;
  } finally {
    explanationLoading = false;
    explainButton.disabled = !siteState.crop;
    if (!siteState.explanation) explainButton.textContent = "Try explanation again";
  }
}

explainButton.addEventListener("click", explainRecommendation);

async function analyze() {
  clearError();
  const btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing...";

  try {
    const res = await fetch(`${API_BASE}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getReadings()),
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    renderResult(data);
  } catch (err) {
    showError(
      `Couldn't reach the AgriOpt API at ${API_BASE}. Make sure the backend is running ` +
      `(uvicorn main:app --reload) and reachable from this page. Details: ${err.message}`
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Analyze Sample";
  }
}

function renderResult(data) {
  siteState.crop = { best_crop: data.best_crop, confidence_percent: data.confidence, top_3: data.top_3, readings_used: getReadings() };
  updateSoilImportState();
  resetExplanation();
  explanationEmpty.hidden = true;
  const diseaseSelect = document.getElementById("disease-crop");
  if (diseaseSelect.options.length > 1) {
    diseaseSelect.value = data.best_crop;
    updateDiseaseButton();
  } else {
    populateCropSelect().then(() => {
      diseaseSelect.value = data.best_crop;
      updateDiseaseButton();
    });
  }
  document.getElementById("emptyState").style.display = "none";

  const headline = document.getElementById("resultHeadline");
  headline.classList.remove("show");
  void headline.offsetWidth; // restart animation
  headline.classList.add("show");
  document.getElementById("cropName").textContent = data.best_crop;
  document.getElementById("cropConfidence").textContent = `${data.confidence}% model confidence`;

  const list = document.getElementById("top3List");
  list.innerHTML = "";
  list.classList.add("show");

  data.top_3.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "top3-row";
    row.innerHTML = `
      <span class="top3-rank">${i + 1}</span>
      <span class="top3-name">${t.crop}</span>
      <span class="top3-bar-track"><span class="top3-bar-fill rank${i}" style="width:0%"></span></span>
      <span class="top3-pct">${t.confidence}%</span>
    `;
    list.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector(".top3-bar-fill").style.width = `${t.confidence}%`;
    });
  });

  document.getElementById("suitabilitySection").classList.add("show");
  populateCropSelect();
  drawRadarChart(data.best_crop);
}

async function populateCropSelect() {
  const select = document.getElementById("cropSelect");
  const diseaseSelect = document.getElementById("disease-crop");
  const soilSelect = document.getElementById("soil-crop");
  if (select.options.length > 0 && diseaseSelect.options.length > 1 && soilSelect.options.length > 1) return;
  try {
    const res = await fetch(`${API_BASE}/api/model-info`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.classes) || data.classes.length === 0) {
      throw new Error("The crop model did not return its supported crop list.");
    }
    if (!select.options.length) {
      data.classes.forEach(crop => {
        const option = document.createElement("option");
        option.value = crop;
        option.textContent = crop;
        select.appendChild(option);
      });
    }
    if (diseaseSelect.options.length <= 1) {
      diseaseSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a crop";
      diseaseSelect.appendChild(placeholder);
      data.classes.forEach(crop => {
        const option = document.createElement("option");
        option.value = crop;
        option.textContent = crop;
        diseaseSelect.appendChild(option);
      });
    }
    if (soilSelect.options.length <= 1) {
      soilSelect.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a crop";
      soilSelect.appendChild(placeholder);
      data.classes.forEach(crop => {
        const option = document.createElement("option");
        option.value = crop;
        option.textContent = crop;
        soilSelect.appendChild(option);
      });
    }
    diseaseSelect.value = siteState.crop && data.classes.includes(siteState.crop.best_crop)
      ? siteState.crop.best_crop
      : "";
    diseaseSelect.disabled = false;
    soilSelect.disabled = false;
    updateDiseaseButton();
    updateSoilImportState();
  } catch (err) {
    showDiseaseError(`Couldn't load the crop list from the AgriOpt API at ${API_BASE}. Make sure the backend is running. Details: ${err.message}`);
    soilError.textContent = `Couldn't load the crop list from the AgriOpt API at ${API_BASE}. Make sure the backend is running. Details: ${err.message}`;
    soilError.hidden = false;
  }
}

async function checkSuitability() {
  clearError();
  const crop = document.getElementById("cropSelect").value;
  if (!crop) return;

  try {
    const res = await fetch(`${API_BASE}/api/predict/suitability`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...getReadings(), crop }),
    });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    siteState.suitability = { crop: data.crop, verdict: data.verdict, reasons: data.reasons };

    const card = document.getElementById("verdictCard");
    card.classList.remove("show");
    void card.offsetWidth;
    card.className = "verdict-card show " +
      (data.verdict === "Suitable" ? "verdict-suitable" :
       data.verdict === "Partially Suitable" ? "verdict-partial" : "verdict-not");
    document.getElementById("verdictTitle").textContent = `${data.crop}: ${data.verdict}`;
    document.getElementById("verdictReasons").innerHTML = data.reasons.map(r => `<div>${r}</div>`).join("");
    drawRadarChart(data.crop);
  } catch (err) {
    showError(`Suitability check failed: ${err.message}`);
  }
}

document.getElementById("analyzeBtn").addEventListener("click", analyze);
document.getElementById("checkBtn").addEventListener("click", checkSuitability);

// ---------- Theme toggle ----------
const root = document.documentElement;
const themeToggle = document.getElementById("themeToggle");
const iconSun = document.getElementById("iconSun");
const iconMoon = document.getElementById("iconMoon");

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  themeToggle.setAttribute("aria-checked", theme === "light");
  iconSun.classList.toggle("active", theme === "light");
  iconMoon.classList.toggle("active", theme === "dark");
}

themeToggle.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
});

applyTheme("dark");

// ---------- Crop disease diagnosis and treatment ----------
const dzEl = document.getElementById("dropzone");
const fileInput = document.getElementById("disease-file");
const diseaseCropSelect = document.getElementById("disease-crop");
const diseasePartSelect = document.getElementById("disease-part");
const previewEl = document.getElementById("disease-preview");
const dzEmpty = document.getElementById("dropzone-empty");
const diseaseBtn = document.getElementById("disease-btn");
const diseaseErr = document.getElementById("disease-error");
const diseaseOut = document.getElementById("disease-result");
let diseaseImage = null; // { base64, mime }
let diseaseAnalyzing = false;

// ---------- Crop-specific soil analysis and amendment advice ----------
const soilForm = document.getElementById("soil-form");
const soilCropSelect = document.getElementById("soil-crop");
const soilImportButton = document.getElementById("soil-import");
const soilImportStatus = document.getElementById("soil-import-status");
const soilError = document.getElementById("soil-error");
const soilEmpty = document.getElementById("soil-empty");
const soilResult = document.getElementById("soil-result");
const soilAnalyzeButton = document.getElementById("soil-analyze");
const SOIL_FIELDS = ["N", "P", "K", "temperature", "humidity", "ph", "rainfall"];
let soilAnalysisVersion = 0;

function updateSoilImportState() {
  const readings = siteState.crop && siteState.crop.readings_used;
  const available = readings && SOIL_FIELDS.every(key => Number.isFinite(readings[key]));
  soilImportButton.disabled = !available;
  soilImportStatus.textContent = available
    ? `Latest analyzed sample is ready to import (recommended crop: ${siteState.crop.best_crop}).`
    : "Analyze a sample on the Crop recommendation page to enable importing.";
}

function invalidateSoilAdvice() {
  soilAnalysisVersion += 1;
  soilError.hidden = true;
  soilResult.hidden = true;
  soilEmpty.hidden = false;
  siteState.soilAdvice = null;
}

SOIL_FIELDS.forEach(key => {
  document.getElementById(`soil-${key}`).addEventListener("input", invalidateSoilAdvice);
});
document.getElementById("soil-texture").addEventListener("change", invalidateSoilAdvice);

soilImportButton.addEventListener("click", () => {
  const readings = siteState.crop && siteState.crop.readings_used;
  if (!readings) return;
  SOIL_FIELDS.forEach(key => {
    document.getElementById(`soil-${key}`).value = readings[key];
  });
  soilImportStatus.textContent = `Imported the soil and climate readings from the latest ${siteState.crop.best_crop} recommendation sample.`;
  soilError.hidden = true;
});

soilCropSelect.addEventListener("change", () => {
  invalidateSoilAdvice();
});

function appendSoilSection(parent, title, contents) {
  const section = document.createElement("section");
  section.className = "soil-result-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.appendChild(heading);
  if (Array.isArray(contents)) {
    const list = document.createElement("ul");
    contents.forEach(content => {
      const item = document.createElement("li");
      if (typeof content === "string") {
        item.textContent = content;
      } else {
        const strong = document.createElement("strong");
        strong.textContent = `${content.supplement} — ${content.category}`;
        const detail = document.createElement("span");
        detail.textContent = `${content.purpose} Caution: ${content.caution}`;
        item.append(strong, detail);
      }
      list.appendChild(item);
    });
    section.appendChild(list);
  } else {
    const text = document.createElement("p");
    text.textContent = contents;
    section.appendChild(text);
  }
  parent.appendChild(section);
}

function renderSoilAdvice(data) {
  siteState.soilAdvice = data;
  soilResult.replaceChildren();
  if (data.analysis_notice) {
    const notice = document.createElement("p");
    notice.className = `soil-analysis-notice${data.analysis_source === "local_fallback" ? " local-fallback" : ""}`;
    notice.textContent = data.analysis_notice;
    soilResult.appendChild(notice);
  }
  const heading = document.createElement("h2");
  heading.textContent = `${data.crop}: ${data.soil_classification}`;
  const sample = document.createElement("p");
  sample.className = "soil-result-sample";
  const climate = [
    data.readings.temperature == null ? null : `${data.readings.temperature} °C`,
    data.readings.humidity == null ? null : `${data.readings.humidity}% humidity`,
    data.readings.rainfall == null ? null : `${data.readings.rainfall} mm rainfall`,
  ].filter(Boolean).join(" · ") || "Climate context not provided";
  sample.textContent = `N ${data.readings.N} · P ${data.readings.P} · K ${data.readings.K} kg/ha · pH ${data.readings.ph} · ${climate} · Texture: ${data.readings.texture}`;
  soilResult.append(heading, sample);
  appendSoilSection(soilResult, "Soil profile", data.summary);
  appendSoilSection(soilResult, `Fit for ${data.crop}`, data.crop_fit);
  const nutrientRows = data.nutrient_status.map(item =>
    `${item.nutrient}: ${item.status} — ${item.explanation}`
  );
  appendSoilSection(soilResult, "Measured nutrient readings", nutrientRows);
  appendSoilSection(soilResult, "Suggested amendments and supplements", data.recommendations);
  appendSoilSection(soilResult, "Good soil practices", data.practices);
  appendSoilSection(soilResult, "Uncertainty and next steps", data.uncertainties);
  soilResult.hidden = false;
  soilEmpty.hidden = true;
}

soilForm.addEventListener("submit", async event => {
  event.preventDefault();
  soilError.hidden = true;
  if (!soilForm.reportValidity()) return;
  if (!soilCropSelect.value) {
    soilError.textContent = "Choose the crop you want to grow.";
    soilError.hidden = false;
    soilCropSelect.focus();
    return;
  }
  const payload = {
    crop: soilCropSelect.value,
    ...Object.fromEntries(SOIL_FIELDS.map(key => {
      const value = document.getElementById(`soil-${key}`).value;
      return [key, value === "" ? null : Number(value)];
    })),
    texture: document.getElementById("soil-texture").value,
  };
  const requestVersion = soilAnalysisVersion;
  soilAnalyzeButton.disabled = true;
  soilAnalyzeButton.textContent = "Analyzing soil…";
  try {
    const response = await fetch(`${API_BASE}/api/soil/advice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : `API returned ${response.status}`);
    }
    if (requestVersion !== soilAnalysisVersion) {
      throw new Error("The sample changed while analysis was running. Run it again for the updated values.");
    }
    renderSoilAdvice(data);
  } catch (err) {
    soilError.textContent = err instanceof TypeError
      ? `Couldn't reach the AgriOpt API at ${API_BASE}. Make sure the backend is running.`
      : `Soil analysis failed: ${err.message}`;
    soilError.hidden = false;
  } finally {
    soilAnalyzeButton.disabled = false;
    soilAnalyzeButton.textContent = "Analyze soil for this crop";
  }
});

function updateDiseaseButton() {
  diseaseBtn.disabled = diseaseAnalyzing || !diseaseImage || !diseaseCropSelect.value || !diseasePartSelect.value;
}

dzEl.addEventListener("click", () => fileInput.click());
dzEl.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
dzEl.addEventListener("dragover", e => { e.preventDefault(); dzEl.classList.add("dragover"); });
dzEl.addEventListener("dragleave", () => dzEl.classList.remove("dragover"));
dzEl.addEventListener("drop", e => {
  e.preventDefault();
  dzEl.classList.remove("dragover");
  if (e.dataTransfer.files[0]) handleDiseaseFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleDiseaseFile(fileInput.files[0]); });
diseaseCropSelect.addEventListener("change", () => {
  diseaseErr.hidden = true;
  diseaseOut.hidden = true;
  siteState.disease = null;
  updateDiseaseButton();
});
diseasePartSelect.addEventListener("change", () => {
  diseaseErr.hidden = true;
  diseaseOut.hidden = true;
  siteState.disease = null;
  updateDiseaseButton();
});

function showDiseaseError(msg) {
  diseaseErr.textContent = msg;
  diseaseErr.hidden = false;
}

// Shrink the photo before upload (max 1024px) so requests stay small and fast.
function handleDiseaseFile(file) {
  diseaseErr.hidden = true;
  diseaseOut.hidden = true;
  siteState.disease = null;
  diseaseImage = null;
  previewEl.hidden = true;
  previewEl.removeAttribute("src");
  dzEmpty.hidden = false;
  updateDiseaseButton();
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    showDiseaseError("Please choose a JPG, PNG or WebP image.");
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    diseaseImage = { base64: dataUrl.split(",")[1], mime: "image/jpeg" };
    previewEl.src = dataUrl;
    previewEl.hidden = false;
    dzEmpty.hidden = true;
    updateDiseaseButton();
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { showDiseaseError("That image couldn't be read. Try a different photo."); URL.revokeObjectURL(url); };
  img.src = url;
}

function dEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function dSection(title, content) {
  const sec = dEl("div", "d-section");
  sec.appendChild(dEl("h3", null, title));
  (Array.isArray(content) ? content : [content]).forEach(n => sec.appendChild(n));
  return sec;
}

function dList(items) {
  const ul = dEl("ul");
  items.forEach(t => ul.appendChild(dEl("li", null, t)));
  return ul;
}

function renderDisease(r) {
  siteState.disease = r;
  diseaseOut.replaceChildren();

  if (!r.is_plant) {
    diseaseOut.appendChild(dEl("span", "d-status unknown", "No plant found"));
    diseaseOut.appendChild(dEl("h3", "d-title", "No crop part could be identified"));
    diseaseOut.appendChild(dEl("p", "d-meta", r.notes || "Try a clear photo of the selected crop's affected part."));
    diseaseOut.hidden = false;
    return;
  }

  if (r.matches_selected_crop === false) {
    diseaseOut.appendChild(dEl("span", "d-status unknown", "Crop mismatch"));
    diseaseOut.appendChild(dEl("h3", "d-title", `Photo does not appear to show ${r.selected_crop || diseaseCropSelect.value}`));
    diseaseOut.appendChild(dEl("p", "d-meta",
      `The AI identified ${r.plant || "a different or unclear crop"}. Choose the matching crop and upload another photo for a reliable disease diagnosis.`));
    if (r.notes) diseaseOut.appendChild(dSection("Notes", dEl("p", null, r.notes)));
    diseaseOut.hidden = false;
    return;
  }

  const diagnosisType = r.diagnosis_type || "disease";
  const statusText = r.healthy
    ? "No disease detected"
    : diagnosisType === "nutrient_deficiency"
      ? "Possible nutrient deficiency"
      : diagnosisType === "physiological"
        ? "Possible non-infectious stress"
        : diagnosisType === "unknown"
          ? "Unclear diagnosis"
          : "Possible disease or pest";
  const statusClass = r.healthy
    ? "healthy"
    : ["unknown", "nutrient_deficiency", "physiological"].includes(diagnosisType)
      ? "unknown"
      : "sick";
  diseaseOut.appendChild(dEl("span", `d-status ${statusClass}`, statusText));
  diseaseOut.appendChild(dEl("h3", "d-title", r.healthy ? r.plant : (r.disease || "Unidentified problem")));
  diseaseOut.appendChild(dEl("p", "d-meta",
    `Selected crop: ${r.selected_crop || diseaseCropSelect.value} · Part checked: ${r.plant_part || diseasePartSelect.value} · ` +
    `Identified as: ${r.plant} · Confidence: ${r.confidence}`));

  if (r.symptoms.length) diseaseOut.appendChild(dSection("What I can see", dList(r.symptoms)));
  if (r.cause) diseaseOut.appendChild(dSection("Cause", dEl("p", null, r.cause)));

  if (!r.healthy && !["nutrient_deficiency", "physiological"].includes(diagnosisType)) {
    const medications = (r.medications || []).map(medication => {
      const item = dEl("li");
      item.appendChild(dEl("strong", null, medication.product_or_active_ingredient || "Treatment option"));
      if (medication.reason) item.appendChild(dEl("p", "medication-reason", medication.reason));
      if (medication.cautions) item.appendChild(dEl("p", "medication-caution", medication.cautions));
      return item;
    });
    const medicineContent = medications.length
      ? (() => { const list = dEl("ul", "medication-list"); list.append(...medications); return list; })()
      : dEl("p", null, "No medication can be safely suggested from this image alone. Get the diagnosis confirmed before applying a pesticide or fungicide.");
    diseaseOut.appendChild(dSection("AI-suggested medication options", medicineContent));
  } else if (!r.healthy && ["nutrient_deficiency", "physiological"].includes(diagnosisType)) {
    diseaseOut.appendChild(dSection(
      "Next step",
      dEl("p", null, diagnosisType === "nutrient_deficiency"
        ? "This may be a nutrient problem rather than an infectious disease. Confirm with a soil or plant test before adding nutrients; disease medication will not correct a deficiency."
        : "This may be non-infectious stress rather than a disease or pest. Confirm the cause before applying medication; pesticides will not correct environmental or physical stress.")
    ));
  }

  const t = r.treatment;
  const groups = [["Organic", t.organic], ["Cultural", t.cultural]].filter(g => g[1].length);
  if (groups.length) {
    const nodes = [];
    groups.forEach(([label, items]) => { nodes.push(dEl("div", "d-sub", label)); nodes.push(dList(items)); });
    diseaseOut.appendChild(dSection("Treatment", nodes));
  }

  if (r.prevention.length) diseaseOut.appendChild(dSection("Prevention", dList(r.prevention)));
  if (!r.healthy && diagnosisType !== "nutrient_deficiency" && diagnosisType !== "physiological") {
    diseaseOut.appendChild(dSection(
      "Medication safety",
      dEl("p", null, "These are AI suggestions, not a prescription. Confirm the diagnosis and that the product is approved for this crop and problem in your area. Follow the product label exactly; wear protective equipment and keep pesticides away from people, animals, food, and water.")
    ));
  }
  if (r.notes) diseaseOut.appendChild(dSection("Notes", dEl("p", null, r.notes)));
  diseaseOut.hidden = false;
}

diseaseBtn.addEventListener("click", async () => {
  if (!diseaseImage || !diseaseCropSelect.value || !diseasePartSelect.value) return;
  diseaseAnalyzing = true;
  diseaseBtn.disabled = true;
  diseaseCropSelect.disabled = true;
  diseaseBtn.textContent = "Analyzing…";
  diseaseErr.hidden = true;
  diseaseOut.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/api/disease/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: diseaseImage.base64,
        mime_type: diseaseImage.mime,
        crop: diseaseCropSelect.value,
        plant_part: diseasePartSelect.value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Please try again.");
    renderDisease(data);
  } catch (err) {
    showDiseaseError(err instanceof TypeError
      ? `Couldn't reach the AgriOpt API at ${API_BASE}. Make sure the backend is running.`
      : err.message);
  } finally {
    diseaseBtn.textContent = "Detect disease & suggest treatment";
    diseaseAnalyzing = false;
    diseaseCropSelect.disabled = diseaseCropSelect.options.length <= 1;
    updateDiseaseButton();
  }
});
populateCropSelect();

// ---------- Menu open / close ----------
const MENU_KEY = "agriopt-menu-closed";
const menuOpenBtn = document.getElementById("menuOpen");
const menuCloseBtn = document.getElementById("menuClose");

function setMenu(open) {
  document.body.classList.toggle("menu-closed", !open);
  menuOpenBtn.setAttribute("aria-expanded", String(open));
  menuCloseBtn.setAttribute("aria-expanded", String(open));
  try { localStorage.setItem(MENU_KEY, open ? "0" : "1"); } catch (e) { /* storage unavailable */ }
}

menuCloseBtn.addEventListener("click", () => { setMenu(false); menuOpenBtn.focus(); });
menuOpenBtn.addEventListener("click", () => { setMenu(true); menuCloseBtn.focus(); });

let menuWasClosed = false;
try { menuWasClosed = localStorage.getItem(MENU_KEY) === "1"; } catch (e) { /* ignore */ }
setMenu(!menuWasClosed);

// ---------- AI assistant (Sprout) ----------
const chatBtn = document.getElementById("assistantBtn");
const chatBtns = [chatBtn, document.getElementById("assistantBtnFloat")]; // ribbon button + floating one (menu closed)
const chatPanel = document.getElementById("chat-panel");
const chatLog = document.getElementById("chat-log");
const chatChips = document.getElementById("chat-chips");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatHistory = []; // {role: "user" | "assistant", content}
let chatBusy = false;
let chatGreeted = false;

const CHAT_CHIPS = {
  home: ["What can you help me with?", "How do I pick the right crop?"],
  crop: ["Explain my crop result", "How can I improve my soil?"],
  soil: ["What does my soil profile mean?", "How can I improve soil safely?"],
  explain: ["What do positive SHAP values mean?", "Why is confidence different from accuracy?"],
  disease: ["What does the disease diagnosis mean?", "How should I use a suggested treatment safely?"],
  dataset: ["Which dataset powers crop recommendations?", "Where can I find the dataset credit?"],
};

function currentPageName() {
  return ["#crop", "#soil", "#explain", "#disease", "#dataset"].includes(location.hash) ? location.hash.slice(1) : "home";
}

// Everything Sprout is allowed to "see" on the site.
function getSiteContext() {
  const page = currentPageName();
  return {
    current_page: {
      home: "Home",
      crop: "Crop recommendation",
      soil: "Soil profile and crop-specific improvement",
      explain: "Why this recommendation?",
      disease: "Crop disease detection & treatment",
      dataset: "Dataset info & credits",
    }[page],
    crop_recommendation_page: {
      slider_values_now: getReadings(),
      latest_recommendation: siteState.crop,
      latest_suitability_check: siteState.suitability,
    },
    recommendation_explanation: siteState.explanation,
    crop_disease_page: {
      selected_crop: diseaseCropSelect.value || null,
      selected_plant_part: diseasePartSelect.value || null,
      photo_selected: !!diseaseImage,
      latest_result: siteState.disease,
    },
    soil_analysis_page: {
      selected_crop: soilCropSelect.value || null,
      sample_values: Object.fromEntries(SOIL_FIELDS.map(key => [key, document.getElementById(`soil-${key}`).value || null])),
      texture: document.getElementById("soil-texture").value,
      latest_result: siteState.soilAdvice,
    },
  };
}

function addChatMessage(role, text, isError) {
  const row = document.createElement("div");
  row.className = "chat-row " + (role === "user" ? "user" : "bot");
  if (role !== "user") {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", "#sprout-face");
    svg.appendChild(use);
    row.appendChild(svg);
  }
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble" + (isError ? " error" : "");
  bubble.textContent = text;
  row.appendChild(bubble);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return row;
}

function showTyping() {
  const row = addChatMessage("bot", "");
  const bubble = row.querySelector(".chat-bubble");
  const dots = document.createElement("span");
  dots.className = "typing";
  dots.innerHTML = "<i></i><i></i><i></i>";
  bubble.appendChild(dots);
  return row;
}

function renderChips() {
  chatChips.replaceChildren();
  if (chatHistory.length) return;
  (CHAT_CHIPS[currentPageName()] || []).forEach(text => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-chip";
    b.textContent = text;
    b.addEventListener("click", () => sendChat(text));
    chatChips.appendChild(b);
  });
}

function openChat() {
  chatPanel.hidden = false;
  chatBtns.forEach(b => b.setAttribute("aria-expanded", "true"));
  if (!chatGreeted) {
    addChatMessage("bot", "Hi, I'm Sprout 🌱 I can help with your crops, soil and plant problems, and I can see what you're doing on each page. What would you like to know?");
    chatGreeted = true;
  }
  renderChips();
  chatInput.focus();
}

function closeChat() {
  chatPanel.hidden = true;
  chatBtns.forEach(b => b.setAttribute("aria-expanded", "false"));
  (document.body.classList.contains("menu-closed") ? chatBtns[1] : chatBtn).focus();
}

chatBtns.forEach(b => b.addEventListener("click", () => (chatPanel.hidden ? openChat() : closeChat())));
document.getElementById("chat-close").addEventListener("click", closeChat);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !chatPanel.hidden) closeChat(); });
window.addEventListener("hashchange", () => { if (!chatPanel.hidden) renderChips(); });
chatForm.addEventListener("submit", e => { e.preventDefault(); sendChat(chatInput.value); });

async function sendChat(text) {
  text = text.trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  chatSend.disabled = true;
  chatInput.value = "";
  addChatMessage("user", text);
  chatHistory.push({ role: "user", content: text });
  chatChips.replaceChildren();
  const typing = showTyping();
  try {
    const res = await fetch(`${API_BASE}/api/assistant/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-12), context: getSiteContext() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Sorry, something went wrong. Please try again.");
    typing.remove();
    addChatMessage("bot", data.reply);
    chatHistory.push({ role: "assistant", content: data.reply });
  } catch (err) {
    typing.remove();
    chatHistory.pop(); // forget the failed question so the next one starts cleanly
    addChatMessage("bot", err instanceof TypeError
      ? `I can't reach the AgriOpt server at ${API_BASE}. Please check that the backend is running.`
      : err.message, true);
  } finally {
    chatBusy = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

// ---------- Page navigation ----------
const VIEWS = {
  home: document.getElementById("view-home"),
  crop: document.getElementById("view-crop"),
  soil: document.getElementById("view-soil"),
  explain: document.getElementById("view-explain"),
  disease: document.getElementById("view-disease"),
  dataset: document.getElementById("view-dataset"),
};
const TITLES = {
  home: "AgriOpt — Crop recommendation & disease detection",
  crop: "AgriOpt — Soil & Climate Sample Analysis",
  soil: "AgriOpt — Soil profile & crop improvement",
  explain: "AgriOpt — Why this crop was recommended",
  disease: "AgriOpt — Crop disease detection & treatment",
  dataset: "AgriOpt — Dataset info & credits",
};

function route() {
  const name = ["#crop", "#soil", "#explain", "#disease", "#dataset"].includes(location.hash) ? location.hash.slice(1) : "home";
  Object.entries(VIEWS).forEach(([key, el]) => { el.hidden = key !== name; });
  document.querySelectorAll(".ribbon-link").forEach(a => {
    const on = a.dataset.view === name;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.title = TITLES[name];
  if (name === "explain" && siteState.crop && !siteState.explanation) explainRecommendation();
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
