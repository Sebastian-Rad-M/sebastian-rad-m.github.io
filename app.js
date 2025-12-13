document.addEventListener('DOMContentLoaded', () => {
    
    //1
    const authContainer = document.getElementById('auth-container');
    checkLoginStatus();

    if(authContainer) {
        authContainer.addEventListener('click', () => {
            const isLoggedIn = localStorage.getItem('isLoggedIn');
            
            if (isLoggedIn === 'true') {
                localStorage.setItem('isLoggedIn', 'false');
                alert('You have logged out.');
                window.location.reload();
            } else {
                const user = prompt("User (admin):");
                const pass = prompt("Password (1234):");
                
                if (user === 'admin' && pass === '1234') {
                    localStorage.setItem('isLoggedIn', 'true');
                    localStorage.setItem('username', user);
                    alert('Login successful! Welcome, Admin.');
                    window.location.reload();
                } else {
                    alert('Invalid credentials!');
                }
            }
        });
    }

    function checkLoginStatus() {
        const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
        const userDisplay = document.getElementById('auth-container');
        
        if (userDisplay) {
            if (isLoggedIn) {
                userDisplay.textContent = `Logout (${localStorage.getItem('username')})`;
                userDisplay.style.color = 'darkred';
            } else {
                userDisplay.textContent = 'Login';
                userDisplay.style.color = '#405566';
            }
        }
        return isLoggedIn;
    }
const essaysContainer = document.getElementById('essays-container');
    
    if (essaysContainer) {
        fetch('data.json')
            .then(response => {
                if (!response.ok) {
                    throw new Error("HTTP error " + response.status);
                }
                return response.json();
            })
            .then(data => {
                const loader = document.getElementById('loading-msg');
                if(loader) loader.remove();

                renderEssays(data);
            })
            .catch(err => {
                console.error("AJAX Error:", err);
                essaysContainer.innerHTML += `<p style="color:red">Error loading essays: ${err.message}</p>`;
            });
    }

    function renderEssays(essays) {
        const isAdmin = checkLoginStatus(); 

        essays.forEach(essay => {
          
            const article = document.createElement('div');
            article.className = 'essay-entry'; 
            
            let htmlContent = `
                <a href="${essay.link}" class="post">
                    <div class="essay">
                        <h3>${essay.title}</h3>
                        <div class="essay-date">${essay.date}</div>
                        <p>${essay.description}</p>
                    </div>
                </a>
            `;

            if (isAdmin) {
                htmlContent += `<button class="delete-btn" onclick="alert('Admin feature: Delete essay ID ${essay.id}')">Delete Post 🗑️</button>`;
            }

            htmlContent += `<div class="sep"></div>`;
            
            article.innerHTML = htmlContent;
            essaysContainer.appendChild(article);
        });
    }


    const canvas = document.getElementById('signature-pad');
    
    if (canvas) {
        const ctx = canvas.getContext('2d');
        let isDrawing = false;

        ctx.strokeStyle = "#405566";
        ctx.lineWidth = 2;

        canvas.addEventListener('mousedown', startDrawing);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stopDrawing);
        canvas.addEventListener('mouseout', stopDrawing);

        function startDrawing(e) {
            isDrawing = true;
            draw(e);
        }

        function draw(e) {
            if (!isDrawing) return;

         
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
        }

        function stopDrawing() {
            isDrawing = false;
            ctx.beginPath();
        }

        const clearBtn = document.getElementById('clear-canvas');
        if(clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.preventDefault();
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            });
        }
    }
});