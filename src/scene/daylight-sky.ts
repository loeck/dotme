import { acos, clamp, cos, exp, float, mix, pow, smoothstep, vec3 } from 'three/tsl'
/** Preetham coefficients adapted from Three.js Sky (MIT, three.js authors). */
import type { Node } from 'three/webgpu'

function airMass(elevation: Node<'float'>) {
  const zenith = acos(clamp(elevation, 0, 1))
  return float(1).div(
    cos(zenith).add(pow(float(93.885).sub(zenith.mul(180 / Math.PI)), -1.253).mul(0.15)),
  )
}

export function daylightSky(
  ray: Node<'vec3'>,
  sun: Node<'vec3'>,
  color: Node<'color'>,
  intensity: Node<'float'>,
  showSun: Node<'float'>,
) {
  const betaR = vec3(5.804543e-6, 1.356291e-5, 3.02659e-5)
  const betaM = vec3(1.839992e14, 2.779802e14, 4.079048e14).mul(Math.LOG10E * 4e-18 * 0.005)
  const extinction = exp(betaR.mul(8400).add(betaM.mul(1250)).mul(airMass(ray.y)).negate())
  const cosine = ray.dot(sun)
  const rayleigh = cosine.mul(cosine).add(1).mul(0.0596831)
  const mie = float(0.0795775 * 0.36).div(pow(float(1.64).sub(cosine.mul(1.6)), 1.5))
  const transmission = exp(betaR.mul(8400).add(betaM.mul(1250)).mul(airMass(sun.y)).negate())
  return betaR
    .mul(rayleigh)
    .add(betaM.mul(mie))
    .div(betaR.add(betaM))
    .mul(14)
    .mul(extinction.oneMinus())
    .mul(mix(vec3(1), transmission, 0.7))
    .add(
      color.rgb
        .mul(smoothstep(0.99994, 0.99996, cosine))
        .mul(showSun)
        .mul(intensity)
        .mul(12),
    )
}
