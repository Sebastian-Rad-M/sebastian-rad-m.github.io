document.addEventListener('DOMContentLoaded', function () {
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark');
    }

    const btn = document.querySelector('.theme-toggle');
    
    if (!btn) return;

    btn.addEventListener('click', function () {
        document.body.classList.toggle('dark');
        
        const isDark = document.body.classList.contains('dark');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
    });
});

const submitBtn = document.getElementById('emailBtn');

if (submitBtn) {
  submitBtn.addEventListener('mouseenter', () => {
    const r = Math.floor(Math.random() * 50); 
    const g = Math.floor(Math.random() * 50) + 100; 
    const b = Math.floor(Math.random() * 50) + 100;
    
    submitBtn.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  });
}
