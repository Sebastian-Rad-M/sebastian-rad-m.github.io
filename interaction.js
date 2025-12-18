
const submitBtn = document.getElementById('emailBtn');

submitBtn.addEventListener('mouseenter', () => {
    const r = Math.floor(Math.random() * 50); 
    const g = Math.floor(Math.random() * 50) + 100; 
    const b = Math.floor(Math.random() * 50) + 100;
    
    submitBtn.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
});

