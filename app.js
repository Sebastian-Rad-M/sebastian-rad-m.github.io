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
                if (loader) loader.remove();

                renderFilterBar(data);
                renderEssays(data);
            })
            .catch(err => {
                console.error("AJAX Error:", err);
                essaysContainer.innerHTML += `<p style="color:red">Error loading essays: ${err.message}</p>`;
            });
    }

    function renderFilterBar(essays) {
        // Collect all unique tags
        const allTags = ['All'];
        essays.forEach(e => (e.tags || []).forEach(t => {
            if (!allTags.includes(t)) allTags.push(t);
        }));

        const bar = document.createElement('div');
        bar.className = 'filter-bar';

        allTags.forEach(tag => {
            const btn = document.createElement('button');
            btn.className = 'filter-btn' + (tag === 'All' ? ' active' : '');
            btn.textContent = tag;
            btn.dataset.tag = tag;

            btn.addEventListener('click', () => {
                // Update active state
                bar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Show/hide essay entries
                const entries = essaysContainer.querySelectorAll('.essay-entry');
                entries.forEach(entry => {
                    if (tag === 'All') {
                        entry.classList.remove('hidden');
                    } else {
                        const entryTags = (entry.dataset.tags || '').split(',');
                        entry.classList.toggle('hidden', !entryTags.includes(tag));
                    }
                });
            });

            bar.appendChild(btn);
        });

        essaysContainer.appendChild(bar);
    }

    function renderEssays(essays) {
        essays.forEach(essay => {
            const article = document.createElement('div');
            article.className = 'essay-entry';
            article.dataset.tags = (essay.tags || []).join(',');

            const tagBadgesHTML = (essay.tags || [])
                .map(t => `<span class="tag-badge">${t}</span>`)
                .join('');

            let htmlContent = `
                <a href="${essay.link}" class="post">
                    <div class="essay">
                        <h3>${essay.title}</h3>
                        <div class="essay-date">${essay.date}</div>
                        <p>${essay.description}</p>
                        <div class="essay-tags">${tagBadgesHTML}</div>
                    </div>
                </a>
            `;

            htmlContent += `<div class="sep"></div>`;
            article.innerHTML = htmlContent;
            essaysContainer.appendChild(article);
        });
    }
});
