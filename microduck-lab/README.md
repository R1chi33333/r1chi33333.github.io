# Microduck Lab

A tiny robot duck on your desk that you can drive. **Play it here: [r1chi33333.github.io/microduck-lab](https://r1chi33333.github.io/microduck-lab/)**

- **Play.** Walk it around the desk (WASD/arrow keys, or the joystick on a phone) and pick up toys with its beak (E or Grab). Poke it over and it gets back up. Climb the ramp, or turn off its safety reflex and watch it walk off the table.
- **Sensors.** See the desk the way the duck does, through its 8×8 depth sensor and head camera.
- **Garage.** Put it on the turntable and swap any of its 22 parts, repaint it in four colourways, and give it a new voice.

Built with [three.js](https://threejs.org) for rendering, [Rapier](https://rapier.rs) for physics, procedural IK walking and WebAudio chirps. It's a static site with no build step and runs on desktop and phone.

## Run locally
```
python3 -m http.server
```
Then open `http://localhost:8000/microduck-lab/`.

## Credits and licence
The 3D model is adapted from the open-source Microduck robot by [Pollen Robotics](https://github.com/pollen-robotics/microduck_rl) and is licensed under **CC BY-NC-SA 4.0**. I assembled its meshes into an articulated rig, added a jaw joint and re-encoded it as base64 glTF (`microduck_rig.glb.txt`). The modified model keeps the same licence, so it is for non-commercial use only.
