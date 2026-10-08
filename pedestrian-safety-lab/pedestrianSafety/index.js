// pedestrianSafety/index.js
//
// Public entry point for the Pedestrian Safety Mode module, ported into
// this project's backend as an ES module (was CommonJS in the standalone
// prototype at https://.../pedestrian-safety-mode). Logic is unchanged --
// see scoring.js for the actual calculation and its documented limitations.
//
// Example usage:
//
//   import {
//     analyzePedestrianRouteSafety,
//     sampleRouteTaipei,
//     realAccidentsTaipei,
//     realStreetlightsTaipei,
//     mockConvenienceStoresTaipei,
//   } from "./pedestrianSafety/index.js";
//
//   const result = analyzePedestrianRouteSafety(
//     sampleRouteTaipei,
//     realAccidentsTaipei,
//     realStreetlightsTaipei,
//     mockConvenienceStoresTaipei,
//     150 // buffer radius in meters
//   );

export * from "./scoring.js";
export * from "./data/mockTaipeiData.js";
export * from "./data/realTaipeiData.js";
