import { CLOUD_SHADOW_GLSL } from './cloud-shadows'

/** Direct water lighting uses Three's live lights and their individual shadow maps. */
export const WATER_LIGHTING_GLSL = `
${CLOUD_SHADOW_GLSL}
// GGX with the dielectric Fresnel reflectance of water (IOR 1.333).
vec3 waterBRDF(vec3 n, vec3 v, vec3 l, vec3 radiance, float roughness) {
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 0.001);
  vec3 h = normalize(l + v);
  float nh = max(dot(n, h), 0.0);
  float vh = max(dot(v, h), 0.0);
  float alpha = roughness;
  float a2 = alpha * alpha;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float distribution = a2 / max(PI * d * d, 0.000001);
  float visibility = 0.5 / max(
    nl * sqrt(nv * nv * (1.0 - a2) + a2) +
    nv * sqrt(nl * nl * (1.0 - a2) + a2), 0.0001);
  float fresnel = 0.0204 + 0.9796 * pow(1.0 - vh, 5.0);
  return radiance * nl * distribution * visibility * fresnel;
}

vec3 waterLighting(vec3 worldNormal, vec3 worldView, float roughness, float foam, float cloudVisibility) {
  vec3 n = normalize(mat3(viewMatrix) * worldNormal);
  vec3 v = normalize(mat3(viewMatrix) * worldView);
  vec3 viewPosition = (viewMatrix * vec4(vWorldPosition, 1.0)).xyz;
  // Unresolved normal variance broadens highlights instead of flickering.
  float filteredRoughness = sqrt(roughness * roughness + min(0.025,
    0.25 * (dot(dFdx(worldNormal), dFdx(worldNormal)) + dot(dFdy(worldNormal), dFdy(worldNormal)))));
  vec3 foamAlbedo = vec3(0.55, 0.60, 0.59) * foam;
  vec3 result = ambientLightColor * foamAlbedo * mix(0.35, 1.0, cloudVisibility);
  filteredRoughness = mix(filteredRoughness, 0.4, foam);
  IncidentLight light;
  float visibility;
  #if defined(USE_SHADOWMAP) && NUM_POINT_LIGHT_SHADOWS > 0
    PointLightShadow pointShadow;
  #endif
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow directionalShadow;
  #endif

  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
    getPointLightInfo(pointLights[i], viewPosition, light);
    if (light.visible) {
    visibility = 1.0;
    #if defined(USE_SHADOWMAP) && UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS
      pointShadow = pointLightShadows[i];
      visibility = getPointShadow(pointShadowMap[i], pointShadow.shadowMapSize,
        pointShadow.shadowIntensity, pointShadow.shadowBias, pointShadow.shadowRadius,
        vPointShadowCoord[i], pointShadow.shadowCameraNear, pointShadow.shadowCameraFar);
    #endif
    result += waterBRDF(n, v, light.direction, light.color, filteredRoughness) * visibility;
    result += foamAlbedo * light.color * max(dot(n, light.direction), 0.0) * visibility / PI;
    }
  }
  #pragma unroll_loop_end
  #endif

  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    getDirectionalLightInfo(directionalLights[i], light);
    light.color *= cloudVisibility;
    visibility = 1.0;
    #if defined(USE_SHADOWMAP) && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS
      directionalShadow = directionalLightShadows[i];
      visibility = getShadow(directionalShadowMap[i], directionalShadow.shadowMapSize,
        directionalShadow.shadowIntensity, directionalShadow.shadowBias, directionalShadow.shadowRadius,
        vDirectionalShadowCoord[i]);
    #endif
    result += waterBRDF(n, v, light.direction, light.color, filteredRoughness) * visibility;
    result += foamAlbedo * light.color * max(dot(n, light.direction), 0.0) * visibility / PI;
  }
  #pragma unroll_loop_end
  #endif
  return result;
}
`
