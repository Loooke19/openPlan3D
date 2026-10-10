import {
  Box3,
  Object3D,
  PerspectiveCamera,
  Spherical,
  Vector3,
  type Camera,
  type Vector3Like,
} from 'three';

/** Camera coordinates are local to a floor, just like its walls and furniture. */
export function setFloorCameraPose(camera: Camera, elevation: number, position: Vector3Like, target: Vector3Like) {
  camera.position.set(position.x, position.y + elevation, position.z);
  camera.lookAt(target.x, target.y + elevation, target.z);
}

/** Orbit view relative to a floor's bounding-box center (not world origin). */
export type RelativeOrbitView = {
  /** Spherical offset of the camera from the orbit target. */
  radius: number;
  phi: number;
  theta: number;
  /** Orbit target offset from the floor bbox center — preserves pan. */
  targetOffset: { x: number; y: number; z: number };
};

const _center = new Vector3();
const _offset = new Vector3();
const _spherical = new Spherical();

/** World-space center of floor geometry; falls back to origin when empty. */
export function floorBoundsCenter(root: Object3D, out = new Vector3()): Vector3 {
  const box = new Box3().setFromObject(root);
  if (box.isEmpty()) return out.set(0, 0, 0);
  return box.getCenter(out);
}

/**
 * Capture orbit distance/angles and pan relative to the current floor center.
 * Replaying this against another floor's center keeps zoom and facing consistent
 * even when CAD-imported floors have different plan origins.
 */
export function captureRelativeOrbitView(
  camera: PerspectiveCamera,
  target: Vector3,
  floorCenter: Vector3Like,
): RelativeOrbitView {
  _offset.copy(camera.position).sub(target);
  _spherical.setFromVector3(_offset);
  return {
    radius: _spherical.radius,
    phi: _spherical.phi,
    theta: _spherical.theta,
    targetOffset: {
      x: target.x - floorCenter.x,
      y: target.y - floorCenter.y,
      z: target.z - floorCenter.z,
    },
  };
}

/** Apply a previously captured relative orbit to a (possibly different) floor center. */
export function applyRelativeOrbitView(
  camera: PerspectiveCamera,
  target: Vector3,
  floorCenter: Vector3Like,
  view: RelativeOrbitView,
): void {
  target.set(
    floorCenter.x + view.targetOffset.x,
    floorCenter.y + view.targetOffset.y,
    floorCenter.z + view.targetOffset.z,
  );
  _spherical.radius = Math.max(view.radius, camera.near * 2);
  _spherical.phi = view.phi;
  _spherical.theta = view.theta;
  camera.position.copy(target).add(_offset.setFromSpherical(_spherical));
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

/** Convenience: capture from a scene root's current bbox center. */
export function captureOrbitRelativeToFloor(
  root: Object3D,
  camera: PerspectiveCamera,
  target: Vector3,
): RelativeOrbitView {
  return captureRelativeOrbitView(camera, target, floorBoundsCenter(root, _center));
}

/** Convenience: restore orbit relative to a scene root's bbox center. */
export function applyOrbitRelativeToFloor(
  root: Object3D,
  camera: PerspectiveCamera,
  target: Vector3,
  view: RelativeOrbitView,
): void {
  applyRelativeOrbitView(camera, target, floorBoundsCenter(root, _center), view);
}
