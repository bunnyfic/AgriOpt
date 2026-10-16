"""
OptiCrop - Model Training Script
Trains the Stacking Ensemble (RF + KNN + SVM + Gradient Boosting -> Logistic Regression meta-model)
on the crop recommendation dataset and saves artifacts for the FastAPI backend to load.

Usage:
    python train_model.py --data /path/to/Crop_recommendation.csv
"""
import argparse
import json
import os

import joblib
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier, StackingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from sklearn.model_selection import train_test_split
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

FEATURES = ["N", "P", "K", "temperature", "humidity", "ph", "rainfall"]
MODEL_DIR = os.path.join(os.path.dirname(__file__), "model")


def main(data_path: str):
    os.makedirs(MODEL_DIR, exist_ok=True)

    df = pd.read_csv(data_path)
    X = df[FEATURES]
    y = df["label"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Base learners (params from GridSearchCV tuning done during the research phase)
    rf = RandomForestClassifier(n_estimators=300, max_depth=None, min_samples_split=2, random_state=42)
    knn = KNeighborsClassifier(n_neighbors=5, weights="distance")
    svm = SVC(C=10, gamma="scale", kernel="rbf", probability=True, random_state=42)
    gb = GradientBoostingClassifier(n_estimators=200, max_depth=3, random_state=42)

    stacking_clf = StackingClassifier(
        estimators=[("rf", rf), ("knn", knn), ("svm", svm), ("gb", gb)],
        final_estimator=LogisticRegression(max_iter=1000),
        cv=5,
        n_jobs=-1,
    )

    print("Training stacking ensemble...")
    stacking_clf.fit(X_train_scaled, y_train)

    preds = stacking_clf.predict(X_test_scaled)
    acc = accuracy_score(y_test, preds)
    f1 = f1_score(y_test, preds, average="macro")
    print(f"Test accuracy: {acc:.4f}")
    print(f"Test macro F1: {f1:.4f}")

    class_labels = sorted(y.unique().tolist())

    joblib.dump(stacking_clf, os.path.join(MODEL_DIR, "crop_model.joblib"))
    joblib.dump(scaler, os.path.join(MODEL_DIR, "scaler.joblib"))

    metadata = {
        "model_type": "StackingClassifier(RF+KNN+SVM+GB -> LogisticRegression)",
        "features": FEATURES,
        "classes": class_labels,
        "test_accuracy": acc,
        "test_macro_f1": f1,
        "requires_scaling": True,
    }
    with open(os.path.join(MODEL_DIR, "model_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"Saved model artifacts to {MODEL_DIR}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="Path to Crop_recommendation.csv")
    args = parser.parse_args()
    main(args.data)
