// Recent checks (saved on this device only). Loads after script.js and wraps renderDisease().
(function () {
  const KEY = "agriopt-disease-history";
  const MAX = 5;
  const listEl = document.getElementById("history-list");
  const emptyEl = document.getElementById("history-empty");
  const clearBtn = document.getElementById("history-clear");

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function save(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage full or blocked */ }
  }

  // Tiny thumbnail of the photo that was just analysed.
  function makeThumb() {
    return new Promise(resolve => {
      const src = document.getElementById("disease-preview").src;
      if (!src) return resolve("");
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 96 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.6));
      };
      img.onerror = () => resolve("");
      img.src = src;
    });
  }

  function render() {
    const items = load();
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;
    clearBtn.hidden = items.length === 0;

    items.forEach(it => {
      const li = document.createElement("li");
      if (it.thumb) {
        const img = document.createElement("img");
        img.src = it.thumb;
        img.alt = "";
        li.appendChild(img);
      }
      const text = document.createElement("div");
      text.className = "history-text";
      const title = document.createElement("span");
      title.className = "history-title";
      title.textContent = it.title;
      const meta = document.createElement("span");
      meta.className = "history-meta";
      meta.textContent = it.plant + " · " + new Date(it.time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      text.append(title, meta);
      const dot = document.createElement("span");
      dot.className = "history-dot " + it.status;
      li.append(text, dot);
      listEl.appendChild(li);
    });
  }

  async function addEntry(r) {
    let title, status;
    if (!r.is_plant) { title = "No plant found"; status = "unknown"; }
    else if (r.matches_selected_crop === false) { title = "Crop mismatch"; status = "unknown"; }
    else if (r.healthy) { title = "Looks healthy"; status = "healthy"; }
    else { title = r.disease || "Unidentified problem"; status = "sick"; }

    const entry = {
      time: Date.now(),
      title,
      status,
      plant: r.selected_crop || (r.is_plant ? r.plant : "Unknown"),
      thumb: await makeThumb(),
    };
    save([entry, ...load()].slice(0, MAX));
    render();
  }

  clearBtn.addEventListener("click", () => { save([]); render(); });

  // Hook into the existing result renderer.
  const originalRender = renderDisease;
  renderDisease = function (r) {
    originalRender(r);
    addEntry(r);
  };

  // Camera: phones open the native camera app; computers open a live webcam preview.
  const camBtn = document.getElementById("camera-btn");
  const camInput = document.getElementById("camera-file");
  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  camInput.addEventListener("change", () => {
    if (camInput.files[0]) handleDiseaseFile(camInput.files[0]);
    camInput.value = ""; // lets the same shot be retaken
  });

  function openWebcam() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camInput.click(); // browser can't do live video: fall back to file picker
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "cam-overlay";
    overlay.innerHTML =
      '<div class="cam-box" role="dialog" aria-label="Take a photo">' +
      '<p class="cam-msg">Starting camera… allow access if your browser asks.</p>' +
      '<video autoplay playsinline muted></video>' +
      '<div class="cam-actions"><button type="button" class="cam-shoot" disabled>Capture</button>' +
      '<button type="button" class="cam-cancel">Cancel</button></div></div>';
    document.body.appendChild(overlay);

    const video = overlay.querySelector("video");
    const msg = overlay.querySelector(".cam-msg");
    const shoot = overlay.querySelector(".cam-shoot");
    let stream = null;

    function close() {
      if (stream) stream.getTracks().forEach(t => t.stop());
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      camBtn.focus();
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    overlay.querySelector(".cam-cancel").addEventListener("click", close);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(s => {
        stream = s;
        video.srcObject = s;
        msg.textContent = "Point the camera at the leaf, then press Capture.";
        shoot.disabled = false;
        shoot.focus();
      })
      .catch(() => {
        msg.textContent = "Couldn't open the camera. Check that it is allowed for this site and not used by another app. You can also choose a photo instead.";
      });

    shoot.addEventListener("click", () => {
      if (!video.videoWidth) return;
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      c.toBlob(blob => {
        if (blob) handleDiseaseFile(new File([blob], "camera.jpg", { type: "image/jpeg" }));
        close();
      }, "image/jpeg", 0.92);
    });
  }

  camBtn.addEventListener("click", () => (isTouch ? camInput.click() : openWebcam()));

  render();
})();