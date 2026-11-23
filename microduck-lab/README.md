# Microduck Lab

A flock of tiny robot ducks loose in a living room. **Play it here: [r1chi33333.github.io/microduck-lab](https://r1chi33333.github.io/microduck-lab/)**

## What you can do
- **Drive a duck.** Use WASD/arrow keys, or the joystick on a phone. Pick up toys with its beak (E / Grab). Click a duck to poke it over and it gets back up.
- **Moves.** Sit (X), crouch (C) and emotes: nod, head shake, dance, look around (1–4).
- **Roller skates (K).** Glide with momentum. Go too fast and it wipes out.
- **Laser pointer (L).** Point at the floor and every duck nearby chases the dot.
- **Football (F).** Kick the sock ball on the rug pitch, orange against teal.
- **Race (R).** 3-2-1-GO, then race the other ducks around the cones.
- **Flock.** Up to 8 ducks (4 on phones). Click one or press Tab to take control. The rest wander, follow you, fetch toys and play on their own.
- **Inventory.** Drag ducks, skates and 13 kinds of toys from the bottom bar into the room. Delete with the trash slot or a right-click.
- **Garage.** Swap any of a duck's 22 parts, repaint it in four colourways and give it a new voice.
- **Views.** X-ray shows the servos inside, and Sensors shows what a duck's depth sensor and camera see.

The room has a sofa, a coffee table, a shelf, a rug football pitch, a race track, and a cardboard ramp up onto the big table.

## Tech
- [three.js](https://threejs.org) for rendering
- [Rapier](https://rapier.rs) for physics
- Procedural IK walking, boids-style flocking, and WebAudio chirps
- A static site with no build step

## Run locally
```
python3 -m http.server
```
Then open `http://localhost:8000/microduck-lab/`.

## Credits and licence
The 3D model is adapted from the open-source Microduck robot by [Pollen Robotics](https://github.com/pollen-robotics/microduck_rl), licensed under **CC BY-NC-SA 4.0**. I assembled its meshes into an articulated rig, added a jaw joint and re-encoded it as base64 glTF (`microduck_rig.glb.txt`). The modified model keeps the same licence and is for non-commercial use only.
