/**
 * references.js
 * Fetches reference data from references.json and renders cards into .ref-grid.
 */

async function loadReferences() {
  const grid = document.getElementById('ref-grid');
  try {
    const response = await fetch('references.json');
    if (!response.ok) {
      throw new Error(`Failed to load references.json (HTTP ${response.status})`);
    }
    const data = await response.json();
    const references = data.references;

    if (!Array.isArray(references) || references.length === 0) {
      grid.innerHTML = '<p>No references found.</p>';
      return;
    }

    grid.innerHTML = '';

    references.forEach(ref => {
      const card = createCard(ref);
      grid.appendChild(card);
    });

  } catch (error) {
    console.error('Error loading references:', error);
    grid.innerHTML = `<p style="color: red;">Could not load references: ${error.message}</p>`;
  }
}

/**
 * Creates and returns a single reference card DOM element.
 * @param {Object} ref - A reference object from the JSON.
 * @returns {HTMLElement}
 */
function createCard(ref) {
  const card = document.createElement('div');
  card.className = 'ref-card';

  card.innerHTML = `
    <div class="ref-card-img">
      <img src="${ref.image}" alt="${ref.alt || ref.title}">
    </div>
    <div class="ref-card-body">
      <div class="ref-card-title">${ref.title}</div>
      <div class="ref-card-author">${ref.author}</div>
      <p class="ref-card-desc">${ref.description}</p>
    </div>
  `;

  return card;
}

document.addEventListener('DOMContentLoaded', loadReferences);
