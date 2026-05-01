document.addEventListener('DOMContentLoaded', () => {

    // 1. Elements
    const modalOverlay = document.getElementById('createRoomModal');
    const openBtn = document.getElementById('openCreateBtn');
    const cancelBtn = document.getElementById('cancelCreateBtn');

    // Select the input and submit button specifically inside the modal
    // (Using querySelector since your HTML uses classes for these)
    const nameInput = modalOverlay ? modalOverlay.querySelector('.modal-input') : null;
    const submitBtn = modalOverlay ? modalOverlay.querySelector('.btn-submit') : null;

    // 2. Open Modal Logic
    if(openBtn && modalOverlay) {
        openBtn.addEventListener('click', () => {
            modalOverlay.classList.add('active');
            if(nameInput) {
                nameInput.value = ''; // Clear previous text
                nameInput.focus();
            }
        });
    }

    // 3. Close Modal Logic
    const closeModal = () => {
        if(modalOverlay) modalOverlay.classList.remove('active');
    };

    if(cancelBtn) {
        cancelBtn.addEventListener('click', closeModal);
    }

    if(modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            // Close if clicking the dark background (overlay)
            if (e.target === modalOverlay) {
                closeModal();
            }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalOverlay && modalOverlay.classList.contains('active')) {
            closeModal();
        }
    });

    // 4. SUBMIT LOGIC (Connects to Flask)
    if (submitBtn && nameInput) {
        const submitRoom = async () => {
            const roomName = nameInput.value.trim();

            if (!roomName) {
                alert("Please enter a room name");
                return;
            }

            // Visual feedback: Disable button while loading
            submitBtn.disabled = true;
            submitBtn.innerText = "Creating...";

            try {
                // Send data to Flask
                const response = await fetch('/create-room', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ name: roomName })
                });

                const data = await response.json();

                if (data.success) {
                    // Redirect user to the new room
                    window.location.href = data.redirect_url;
                } else {
                    alert(data.error || "Error creating room");
                    submitBtn.disabled = false;
                    submitBtn.innerText = "Create";
                }
            } catch (err) {
                console.error("Error:", err);
                alert("Server connection failed. Check console for details.");
                submitBtn.disabled = false;
                submitBtn.innerText = "Create";
            }
        };

        // Click event
        submitBtn.addEventListener('click', submitRoom);

        // Enter key event (Quality of Life)
        nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // Stop default form submission if inside a form tag
                submitRoom();
            }
        });
    }
});