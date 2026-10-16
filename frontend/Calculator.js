// AgriOpt — "Enter manually" mini calculator for the Crop recommendation page.
// Walks the user through the 7 readings one at a time on a keypad, then runs the analysis automatically.
// Needs script.js loaded first (uses FIELDS, updateFill, analyze).
(function () {
  const panel = document.querySelector("#view-crop .sample-panel");
  if (!panel || typeof FIELDS === "undefined") return;

  const SHORT = { N: "N", P: "P", K: "K", temperature: "Temp", humidity: "Humid", ph: "pH", rainfall: "Rain" };
  const last = FIELDS.length - 1;
  const decimalsOf = step => (String(step).split(".")[1] || "").length;

  let idx = 0;
  let buf = "";
  let vals = FIELDS.map(() => null);
  let lastFocus = null;

  // ----- open button (top-right of the Sample Readings card) -----
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "calc-open";
  openBtn.setAttribute("aria-haspopup", "dialog");
  openBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="3" width="14" height="18" rx="3"/><rect x="8" y="6" width="8" height="3.5" rx="1"/>' +
    '<path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"/></svg>' +
    "<span>Enter manually</span>";
  panel.classList.add("has-calc");
  panel.appendChild(openBtn);

  // ----- dialog -----
  const overlay = document.createElement("div");
  overlay.className = "calc-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="calc-box" role="dialog" aria-modal="true" aria-label="Enter sample readings" tabindex="-1">
      <div class="calc-top">
        <span class="calc-title">Sample calculator</span>
        <button type="button" class="calc-x" aria-label="Close calculator">&times;</button>
      </div>
      <div class="calc-steps" id="calcSteps"></div>
      <div class="calc-screen" aria-live="polite">
        <div class="calc-field"><span id="calcName"></span><span id="calcCount"></span></div>
        <div class="calc-display"><span id="calcValue"></span><span class="calc-unit" id="calcUnit"></span></div>
        <div class="calc-hint" id="calcHint"></div>
      </div>
      <div class="calc-keys" id="calcKeys"></div>
      <div class="calc-actions">
        <button type="button" class="calc-btn calc-back" id="calcBack">Back</button>
        <button type="button" class="calc-btn calc-next" id="calcNext">Next</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const box = overlay.querySelector(".calc-box");
  const stepsEl = overlay.querySelector("#calcSteps");
  const nameEl = overlay.querySelector("#calcName");
  const countEl = overlay.querySelector("#calcCount");
  const valueEl = overlay.querySelector("#calcValue");
  const unitEl = overlay.querySelector("#calcUnit");
  const hintEl = overlay.querySelector("#calcHint");
  const keysEl = overlay.querySelector("#calcKeys");
  const backBtn = overlay.querySelector("#calcBack");
  const nextBtn = overlay.querySelector("#calcNext");

  // keypad
  ["7", "8", "9", "C", "4", "5", "6", "⌫", "1", "2", "3", ".", "0"].forEach(k => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "calc-key" + (k === "C" || k === "⌫" ? " calc-key-fn" : "") + (k === "0" ? " calc-key-zero" : "");
    b.dataset.key = k;
    b.textContent = k;
    if (k === "⌫") b.setAttribute("aria-label", "Delete last digit");
    if (k === "C") b.setAttribute("aria-label", "Clear");
    keysEl.appendChild(b);
  });

  function setHint(msg, isError) {
    hintEl.textContent = msg;
    hintEl.classList.toggle("error", !!isError);
  }

  function render() {
    const [key, label, unit, min, max, step] = FIELDS[idx];
    nameEl.textContent = label;
    countEl.textContent = `Step ${idx + 1} of ${FIELDS.length}`;
    unitEl.textContent = unit;
    valueEl.textContent = buf === "" ? "0" : buf;
    valueEl.classList.toggle("placeholder", buf === "");
    setHint(`Allowed range: ${min} to ${max}${unit ? " " + unit : ""}`, false);
    backBtn.disabled = idx === 0;
    nextBtn.textContent = idx === last ? "Analyze" : "Next";

    stepsEl.replaceChildren();
    FIELDS.forEach((f, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "calc-chip" + (i === idx ? " active" : "") + (vals[i] !== null ? " done" : "");
      b.dataset.i = i;
      const s = document.createElement("span");
      s.textContent = SHORT[f[0]];
      const v = document.createElement("strong");
      v.textContent = vals[i] !== null ? vals[i] : "–";
      b.append(s, v);
      b.setAttribute("aria-label", `${f[1]}: ${vals[i] !== null ? vals[i] : "not entered"}`);
      stepsEl.appendChild(b);
    });
  }

  // Returns the validated number, or null (and shows why).
  function validate() {
    const [, label, unit, min, max, step] = FIELDS[idx];
    if (buf === "" || buf === ".") { setHint(`Please enter ${label.toLowerCase()}.`, true); return null; }
    let v = parseFloat(buf);
    if (!isFinite(v)) { setHint("That isn't a valid number.", true); return null; }
    if (v < min || v > max) { setHint(`${label} must be between ${min} and ${max}${unit ? " " + unit : ""}.`, true); return null; }
    v = Math.round(v / step) * step;
    return Number(v.toFixed(decimalsOf(step)));
  }

  function loadBuf() { buf = vals[idx] !== null ? String(vals[idx]) : ""; }

  function press(k) {
    const step = FIELDS[idx][5];
    if (k === "C") buf = "";
    else if (k === "⌫") buf = buf.slice(0, -1);
    else if (k === ".") {
      if (decimalsOf(step) === 0 || buf.includes(".")) return;
      buf = (buf === "" ? "0" : buf) + ".";
    } else {
      if (buf.replace(".", "").length >= 5) return;
      buf = buf === "0" ? k : buf + k;
    }
    render();
  }

  function goTo(i) {
    // keep what was typed on this step if it is valid; otherwise just move on
    const saved = buf !== "" ? validate() : null;
    if (saved !== null) vals[idx] = saved;
    idx = i;
    loadBuf();
    render();
  }

  function next() {
    const v = validate();
    if (v === null) return;
    vals[idx] = v;
    if (idx < last) { idx++; loadBuf(); render(); }
    else finish();
  }

  function finish() {
    FIELDS.forEach(([key], i) => {
      const input = document.getElementById(`input-${key}`);
      input.value = vals[i];
      input.dispatchEvent(new Event("input", { bubbles: true })); // moves the slider and updates the radar
    });
    close(false);
    if (window.matchMedia("(max-width: 900px)").matches) {
      const rp = document.querySelector("#view-crop .report-panel");
      if (rp) rp.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    analyze();
  }

  function open() {
    lastFocus = document.activeElement;
    idx = 0;
    vals = FIELDS.map(() => null);
    buf = "";
    render();
    overlay.hidden = false;
    box.focus();
  }

  function close(restoreFocus) {
    overlay.hidden = true;
    if (restoreFocus !== false && lastFocus && lastFocus.focus) lastFocus.focus();
  }

  openBtn.addEventListener("click", open);
  overlay.querySelector(".calc-x").addEventListener("click", () => close());
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  keysEl.addEventListener("click", e => { const b = e.target.closest(".calc-key"); if (b) press(b.dataset.key); });
  stepsEl.addEventListener("click", e => { const b = e.target.closest(".calc-chip"); if (b) goTo(Number(b.dataset.i)); });
  backBtn.addEventListener("click", () => { if (idx > 0) goTo(idx - 1); });
  nextBtn.addEventListener("click", next);

  // physical keyboard
  overlay.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.target.closest("button") && (e.key === "Enter" || e.key === " ")) return; // let focused buttons act normally
    if (/^[0-9]$/.test(e.key) || e.key === ".") { e.preventDefault(); press(e.key); }
    else if (e.key === "Backspace") { e.preventDefault(); press("⌫"); }
    else if (e.key === "Delete") { e.preventDefault(); press("C"); }
    else if (e.key === "Enter") { e.preventDefault(); next(); }
  });
})();