//1 2
const form = document.getElementById('contactForm');
const urgencyInput = document.getElementById('urgency');
const urgencyDisplay = document.getElementById('urgency-value');
const submitBtn = document.getElementById('submitBtn');
const container = document.getElementById('contact-container');
const messageInput = document.getElementById('message');

// 8
const loadTime = new Date();
console.log("Page loaded at: " + loadTime.toLocaleTimeString().toUpperCase());

// 7.
window.addEventListener('load', () => {
    const savedDraft = localStorage.getItem('messageDraft');
    if (savedDraft) {
        messageInput.value = savedDraft;
        console.log("Draft restored from LocalStorage");
    }
});

// 4 6
urgencyInput.addEventListener('input', (event) => {
    // 11
    urgencyDisplay.textContent = event.target.value;
    
    // 5
    
    const intensity = event.target.value * 10; 
    form.style.borderLeft = `${intensity}px solid #afeeee`;
});

// 4
messageInput.addEventListener('keyup', () => {
    localStorage.setItem('messageDraft', messageInput.value);
});

//9
submitBtn.addEventListener('mouseenter', () => {
    const r = Math.floor(Math.random() * 50); 
    const g = Math.floor(Math.random() * 50) + 100; 
    const b = Math.floor(Math.random() * 50) + 100;
    
    submitBtn.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
});
//12
container.addEventListener('click', (e) => {
    const compStyles = window.getComputedStyle(container);
    console.log("Container padding is: " + compStyles.padding);
    container.style.backgroundColor = "#f0f8ff"; 
});
form.addEventListener('click', (e) => {
    e.stopPropagation(); 
});

//3 13
form.addEventListener('submit', (e) => {
    e.preventDefault(); 

    const emailInput = document.getElementById('email');
    const emailVal = emailInput.value;
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    const oldMsg = document.getElementById('dynamic-msg');
    if (oldMsg) oldMsg.remove();

    const statusDiv = document.createElement('div');
    statusDiv.id = 'dynamic-msg';
    statusDiv.style.padding = "10px";
    statusDiv.style.marginTop = "10px";
    statusDiv.style.fontWeight = "bold";

    if (emailRegex.test(emailVal)) {
       
        statusDiv.textContent = "Thank you! Validated & Sent.";
        statusDiv.style.color = "green";
        
        // 10
        emailInput.classList.remove('error-border');
        emailInput.classList.add('success-border');
        //8
        const formData = [document.getElementById('name').value, emailVal];
        console.log("Data to send: " + formData.join(" | ")); 

        // 7
        setTimeout(() => {
            statusDiv.remove();
            form.reset();
            localStorage.removeItem('messageDraft'); 
            form.style.borderLeft = "none";
        }, 3000);

    } else {
        statusDiv.textContent = "Error: Please enter a valid email address.";
        statusDiv.style.color = "red";
        
        emailInput.classList.add('error-border');
    }

    form.appendChild(statusDiv);
});