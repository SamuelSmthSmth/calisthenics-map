let network; 
let exercisesData = []; 

fetch('data.json')
    .then(response => response.json())
    .then(exercises => {
        exercisesData = exercises; 
        
        const nodes = [];
        const edges = [];

        exercises.forEach(ex => {
            // 🎨 COLOR CODING LOGIC
            let nodeColor = '#2196f3'; // Default Blue
            if (ex.category === 'Push') nodeColor = '#e53935'; // Red
            if (ex.category === 'Pull') nodeColor = '#1e88e5'; // Blue
            if (ex.category === 'Core') nodeColor = '#43a047'; // Green
            if (ex.category === 'Static') nodeColor = '#8e24aa'; // Purple
            if (ex.category === 'Hybrid') nodeColor = '#fb8c00'; // Orange

            // 📏 NODE SIZING
            let baseSize = 14;
            let nodeFontSize = ex.tier ? baseSize + (ex.tier * 3) : baseSize;

            // 🔶 SHAPE LOGIC
            let nodeShape = 'box'; // Default (looks best for Statics)
            if (ex.type === 'dynamic') nodeShape = 'ellipse';
            if (ex.type === 'balance') nodeShape = 'hexagon';

            // Create the visual node
            nodes.push({ 
                id: ex.id, 
                label: ex.name,
                shape: nodeShape, // Applies the shape!
                color: { background: nodeColor, border: '#121212' },
                font: { size: nodeFontSize, color: '#ffffff', face: 'Segoe UI' }
            });

            // Connect the unlocks
            if (ex.unlocks) {
                ex.unlocks.forEach(unlockedId => {
                    edges.push({ from: ex.id, to: unlockedId, arrows: 'to' });
                });
            }
        });

        const container = document.getElementById('tree-container');
        const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
        const options = {
            // 🌳 NEW: Force a strict Skill Tree layout
            layout: {
                hierarchical: {
                    enabled: true,
                    direction: 'LR',        // 'LR' draws Left-to-Right. Change to 'UD' if you want Top-to-Bottom.
                    sortMethod: 'directed', // Organizes based on your unlock arrows
                    levelSeparation: 250,   // Horizontal space between tiers
                    nodeSpacing: 80         // Vertical space between nodes
                }
            },
            // Turn off the bouncy gravity so it stays rigid
            physics: { 
                enabled: false 
            },
            nodes: {
                font: { color: '#ffffff', face: 'Segoe UI' },
                shape: 'box',
                margin: 10,
                borderWidth: 2
            },
            edges: { 
                color: '#555555', 
                // Makes the connecting lines curve beautifully along the tree direction
                smooth: { 
                    type: 'cubicBezier', 
                    forceDirection: 'horizontal', 
                    roundness: 0.4 
                } 
            }
        };
        
        network = new vis.Network(container, data, options);

        // Click a node to open the Right Panel
        network.on("click", function (params) {
            if (params.nodes.length > 0) {
                showDetails(params.nodes[0]);
            }
        });

        setupSearch();
    })
    .catch(error => {
        console.error("Oops! There is a typo in your data.json file:", error);
        document.getElementById('tree-container').innerHTML = "<h2 style='color:red; padding:20px;'>Error loading data.json! Check the developer console (F12).</h2>";
    });


// --- UI FUNCTIONS --- //

function showDetails(id) {
    const skill = exercisesData.find(ex => ex.id === id);
    if (!skill) return;

    document.getElementById('detail-title').innerText = skill.name;
    document.getElementById('detail-category').innerText = skill.category;
    document.getElementById('detail-tier').innerText = skill.tier || "1";
    document.getElementById('detail-desc').innerText = skill.description;

    // 🏋️ HANDLE DRILLS
    const recContainer = document.getElementById('detail-recommended');
    const recSection = document.getElementById('recommended-section');
    recContainer.innerHTML = ''; // Clear old badges

    if (skill.drills && skill.drills.length > 0) {
        document.querySelector('#recommended-section h3').innerText = "Training Drills:";
        skill.drills.forEach(drillText => {
            const badge = document.createElement('span');
            badge.className = 'drill-badge'; // We'll style this below
            badge.innerText = drillText;
            recContainer.appendChild(badge);
        });
        recSection.classList.remove('hidden');
    } else {
        recSection.classList.add('hidden');
    }

    document.getElementById('right-panel').classList.remove('hidden');
}

// 🎯 NEW: Reset View Button
document.getElementById('reset-view').addEventListener('click', () => {
    network.fit({ animation: true }); // Automatically zooms out to show the whole tree
});

// Close panel when clicking the X
document.getElementById('close-panel').addEventListener('click', () => {
    document.getElementById('right-panel').classList.add('hidden');
});

function setupSearch() {
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        searchResults.innerHTML = ''; 

        if (query.length === 0) return;

        const matches = exercisesData.filter(ex => ex.name.toLowerCase().includes(query));

        matches.forEach(match => {
            const li = document.createElement('li');
            li.innerText = match.name;
            li.addEventListener('click', () => {
                network.focus(match.id, { scale: 1.2, animation: true });
                network.selectNodes([match.id]);
                showDetails(match.id);
                searchResults.innerHTML = ''; 
                searchInput.value = ''; 
            });
            searchResults.appendChild(li);
        });
    });
}