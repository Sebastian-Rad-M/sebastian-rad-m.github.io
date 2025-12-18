document.addEventListener('DOMContentLoaded', () => {

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

            htmlContent += `<div class="sep"></div>`;
            article.innerHTML = htmlContent;
            essaysContainer.appendChild(article);
        });
    }
});


