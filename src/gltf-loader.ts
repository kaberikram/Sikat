/// <reference types="vite/client" />

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/**
 * Shared GLTFLoader + DRACOLoader for glTF/glB with KHR_draco_mesh_compression.
 * Decoders are in `public/draco/` (from `three/examples/jsm/libs/draco/gltf/`).
 */
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

export { gltfLoader, dracoLoader };
