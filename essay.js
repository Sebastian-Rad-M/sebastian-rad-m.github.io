        const DMIZ= document.getElementById('DMIZ');
        const button = document.getElementById('actionBtn');
        const textDisplay = document.getElementById('myText');
        const content = [
            "(1) A drill going into the earth, searching something, breaking skulls in the process. This is the culture destroying the ones that helped make it, the artists and art, or digging down to the last safe haven of humanity. This is culture degrading the art, through both expectations and standards of conformity.",
            "(2) An arrow or some other weapon piercing flesh. The sporadic paint splatters might be blood, chaos or something else entirely, and the skulls imperfections in said skin. The album is a funeral, the mourning of a death (this is much more apparent in other songs than Ghoti however).",
            "(3) A mountain, presumably Mount Zion breaking the golden sky. This is the technology aiming for new heights. The skulls here are obstacles, that should not be ignored, making this about the allure of technology over tradition, and the losing of meaning that follows.",
            "(4) The figure resembles Pac-Man. He could be either eating the colour (chaos) or puking it. Pac-Man might be a metaphor for gold, capitalism consuming everything, the artificial. This is, as I see it, the clearest interpretation, and the one representing the face value of the tracks."
        ];
        let clickCount = 0;

        button.addEventListener('click', () => {
            clickCount++;
            const rotationDegree = clickCount * -90;
            DMIZ.style.transform = `rotate(${rotationDegree}deg)`;

            const index = clickCount % 4; 
            textDisplay.innerText = content[index];
        });