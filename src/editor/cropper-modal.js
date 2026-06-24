/* Cropper.js modal logic — shares state with editor.js via window.cmsState */

(function () {
  let cropper = null;
  let pendingFieldId = null;
  let originalAspect = null; // numeric aspect ratio of the original image

  const dlg = document.querySelector('#cropDialog');
  const img = document.querySelector('#cropImage');
  const aspectSel = document.querySelector('#aspectSel');
  const meta = document.querySelector('#cropMeta');

  function destroyCropper() {
    if (cropper) { try { cropper.destroy(); } catch (e) {} cropper = null; }
  }

  function applyAspect() {
    if (!cropper) return;
    const v = aspectSel.value;
    let r;
    if (v === '') r = NaN;
    else if (v === 'match' && originalAspect) r = originalAspect;
    else r = parseFloat(v);
    cropper.setAspectRatio(isNaN(r) ? NaN : r);
  }

  // Helper: read the current value for an image field (pending URL change wins)
  function currentValueFor(field) {
    const state = window.cmsState;
    if (state && state.changed.has(field.id)) return state.changed.get(field.id);
    return field.value;
  }

  // Helper: fully open the modal once `img.src` is loaded.
  function openWithLoadedImage(field, target) {
    img.onerror = () => {
      meta.textContent = '⚠ Could not load image (network error or CORS — see console)';
    };
    img.onload = () => {
      let displayAspect = null;
      if (field.width && field.height) {
        displayAspect = parseFloat(field.width) / parseFloat(field.height);
      }
      originalAspect = displayAspect || (img.naturalWidth / img.naturalHeight);
      meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} → target ${target}`;

      destroyCropper();
      cropper = new Cropper(img, {
        aspectRatio: originalAspect,
        viewMode: 1,
        autoCropArea: 0.95,
        background: false,
        movable: true,
        zoomable: true,
      });
      aspectSel.value = 'match';
    };
    dlg.showModal();
  }

  // Public API: 📁 Replace file… (file picker → crop)
  window.openCropperFor = function (fieldId) {
    const state = window.cmsState;
    if (!state) return;
    const field = state.fields.find(x => x.id === fieldId);
    if (!field) return;
    pendingFieldId = fieldId;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.remove();
      if (!file) return;
      img.src = URL.createObjectURL(file);
      openWithLoadedImage(field, currentValueFor(field));
    });
    fileInput.click();
  };

  // Public API: ✂ Crop existing — loads the field's current URL/path into the cropper.
  // Local paths load directly. External URLs go via /__cms/api/image-proxy?url=... so the
  // canvas doesn't get CORS-tainted (Cropper.js needs canvas pixel access).
  window.openCropperForExisting = function (fieldId) {
    const state = window.cmsState;
    if (!state) return;
    const field = state.fields.find(x => x.id === fieldId);
    if (!field) return;
    const cur = currentValueFor(field);
    if (!cur) {
      alert('No image URL/path set on this field.');
      return;
    }
    pendingFieldId = fieldId;

    let src;
    if (/^https?:\/\//i.test(cur)) {
      src = '/__cms/api/image-proxy?url=' + encodeURIComponent(cur);
    } else {
      src = cur.startsWith('/') ? cur : '/' + cur;
    }
    img.src = src;
    openWithLoadedImage(field, cur);
  };

  // Wire dialog buttons
  aspectSel.addEventListener('change', applyAspect);

  document.querySelector('#cropCancel').addEventListener('click', () => {
    destroyCropper();
    dlg.close();
    pendingFieldId = null;
  });

  document.querySelector('#cropOk').addEventListener('click', () => {
    if (!cropper || !pendingFieldId) {
      dlg.close();
      return;
    }
    const state = window.cmsState;
    const field = state.fields.find(x => x.id === pendingFieldId);
    if (!field) { dlg.close(); return; }

    // Cap output to 2400px on the long edge to avoid massive uploads
    const opts = { maxWidth: 2400, maxHeight: 2400, imageSmoothingQuality: 'high' };
    const canvas = cropper.getCroppedCanvas(opts);
    const ext = (String(field.value).match(/\.[a-z0-9]+$/i) || ['.jpg'])[0].toLowerCase();
    const mime = ext === '.png' ? 'image/png'
               : ext === '.webp' ? 'image/webp'
               : 'image/jpeg';
    canvas.toBlob((blob) => {
      if (!blob) { dlg.close(); return; }
      // Use the CURRENT value (URL field may have been edited). External URLs are
      // rewritten to /images/cropped/<...> by the server-side upload handler.
      const destPath = currentValueFor(field);
      window.applyCrop(pendingFieldId, blob, destPath);
      destroyCropper();
      dlg.close();
      pendingFieldId = null;
    }, mime, 0.9);
  });

  // ESC closes via native <dialog>; clean up cropper when it closes
  dlg.addEventListener('close', () => destroyCropper());
})();
