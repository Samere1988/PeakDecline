(() => {
    const form = document.getElementById('profile-details');
    if (!form) return;
    const input = document.getElementById('picture');
    const preview = document.getElementById('picture-preview');
    const summary = document.getElementById('profile-avatar-preview');
    const status = document.getElementById('picture-status');
    const remove = document.getElementById('remove-picture');
    const saved = preview.src;
    let objectUrl;
    function showAvatar(src, alt) {
        preview.src = src;
        preview.alt = alt;
        if (summary) { summary.src = src; summary.alt = alt; }
    }
    function clearPreview() {
        preview.onload = preview.onerror = null;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    }
    function showPreview() {
        clearPreview();
        input.setCustomValidity('');
        const file = input.files[0];
        if (remove.checked) {
            showAvatar('/static/img/avatar-default.svg', 'Preview with profile picture removed');
            status.textContent = 'Picture will be removed when you click Save profile.';
            return;
        }
        showAvatar(saved, 'Current profile picture');
        if (!file) {
            status.textContent = 'Your current picture. Choose a new image to preview it here.';
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            input.setCustomValidity('Choose a picture smaller than 5 MB.');
            status.textContent = 'This picture is too large. Choose a picture smaller than 5 MB.';
            return;
        }
        objectUrl = URL.createObjectURL(file);
        preview.onload = () => {
            if (preview.naturalWidth * preview.naturalHeight > 16000000) {
                clearPreview();
                showAvatar(saved, 'Current profile picture');
                input.setCustomValidity('Choose an image smaller than 16 megapixels.');
                status.textContent = 'This image is too large. Choose an image smaller than 16 megapixels.';
                return;
            }
            if (summary) { summary.src = preview.src; summary.alt = 'Preview of selected profile picture'; }
            preview.alt = 'Preview of selected profile picture';
            status.textContent = 'Preview ready. Click Save profile to apply this picture.';
        };
        preview.onerror = () => {
            clearPreview();
            showAvatar(saved, 'Current profile picture');
            input.setCustomValidity('Choose a valid JPEG, PNG, GIF or WebP image.');
            status.textContent = 'Unable to preview this image. Choose a valid JPEG, PNG, GIF or WebP image.';
        };
        preview.src = objectUrl;
        status.textContent = 'Loading picture preview…';
    }
    input.addEventListener('change', () => { remove.checked = false; showPreview(); });
    remove.addEventListener('change', showPreview);
    form.addEventListener('submit', () => {
        status.textContent = 'Saving your profile…';
        const button = form.querySelector('button[type="submit"]');
        button.textContent = 'Saving…';
        button.disabled = true;
    });
    window.addEventListener('pagehide', clearPreview);
    window.addEventListener('pageshow', () => {
        const button = form.querySelector('button[type="submit"]');
        button.disabled = false;
        button.textContent = 'Save profile';
        showPreview();
    });
})();
