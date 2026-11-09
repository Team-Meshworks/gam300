import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { degreesToQuaternion, quaternionToDegrees } from "./rotation-angles";

describe("rotation angles", () => {
  it("matches three.js XYZ Euler angles", () => {
    const angles: [number, number, number] = [30, -45, 60];
    const [x, y, z] = angles.map((angle) => THREE.MathUtils.degToRad(angle));
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, "XYZ"));
    const quaternion = degreesToQuaternion(angles);
    // angleTo use acos, not so accurate near zero
    expect(new THREE.Quaternion(...quaternion).angleTo(expected)).toBeLessThan(1e-6);
    quaternionToDegrees(quaternion).forEach((value, axis) =>
      expect(value).toBeCloseTo(angles[axis] ?? 0, 9),
    );
  });

  it("reads the identity rotation as zero", () => {
    expect(quaternionToDegrees([0, 0, 0, 1])).toEqual([0, 0, 0]);
  });

  it("returns a unit quaternion the project format accepts", () => {
    const [x, y, z, w] = degreesToQuaternion([123, 45, -270]);
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
  });
});
