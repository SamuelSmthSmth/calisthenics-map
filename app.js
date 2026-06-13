// 1. Fetch the data from your local JSON file
fetch('data.json')
    .then(response => response.json())
    .then(exercises => {
        
        // 2. Prepare data arrays for the visual graph
        const nodes = [];
        const edges = [];

        exercises.forEach(ex => {
            // Create a visual bubble/node for each exercise
            nodes.push({ id: ex.id, label: ex.name, title: ex.description });

            // Connect this exercise to its unlocks with lines (edges)
            ex.unlocks.forEach(unlockedId => {
                edges.push({ from: ex.id, to: unlockedId });
            });
        });

        // 3. Tell Vis.js to draw it inside our HTML container
        const container = document.getElementById('tree-container');
        const data = {
            nodes: new vis.DataSet(nodes),
            edges: new vis.DataSet(edges)
        };
        const options = {
            physics: { solver: 'forceAtlas2Based' } // Makes it bounce into a nice tree layout
        };
        
        new vis.Network(container, data, options);
    });