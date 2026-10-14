// pedestrianSafety/data/mockTaipeiData.js
//
// MOCK DATA ONLY -- none of the coordinates or counts below are real
// Taiwan accident/streetlight/store statistics. Ported unchanged from the
// standalone pedestrian-safety-mode prototype (CommonJS -> ESM). Only used
// when the caller explicitly asks for dataSource=mock (a demo/offline
// mode); "real" mode uses realTaipeiData.js for all three factors,
// including convenience stores as of the dataset refresh described there
// -- this file's mockConvenienceStoresTaipei is kept only so mock mode
// still has something to show, not because no real store data exists.

export const sampleRouteTaipei = [
  { lat: 25.0478, lon: 121.5170 }, // Taipei Main Station
  { lat: 25.0453, lon: 121.5323 }, // Zhongxiao Xinsheng
  { lat: 25.0417, lon: 121.5498 }, // Zhongxiao Dunhua
  { lat: 25.0408, lon: 121.5654 }, // Taipei City Hall
  { lat: 25.0339, lon: 121.5645 }, // Taipei 101
];

export const mockAccidentsTaipei = [
  { latitude: 25.0470, longitude: 121.5185, date: "2024-03-02", accident_type: "pedestrian" },
  { latitude: 25.0449, longitude: 121.5340, date: "2024-05-19", accident_type: "pedestrian" },
  { latitude: 25.0415, longitude: 121.5510, date: "2024-07-08", accident_type: "pedestrian" },
  { latitude: 25.0410, longitude: 121.5648, date: "2024-08-21", accident_type: "pedestrian" },
  { latitude: 25.0345, longitude: 121.5638, date: "2024-09-30", accident_type: "pedestrian" },
  { latitude: 25.0460, longitude: 121.5250, date: "2024-04-11", accident_type: "vehicle-vehicle" },
  { latitude: 25.0400, longitude: 121.5600, date: "2024-06-02", accident_type: "vehicle-vehicle" },
  { latitude: 25.0900, longitude: 121.5000, date: "2024-02-14", accident_type: "pedestrian" },
];

export const mockStreetlightsTaipei = [
  { latitude: 25.0475, longitude: 121.5175 },
  { latitude: 25.0468, longitude: 121.5200 },
  { latitude: 25.0460, longitude: 121.5240 },
  { latitude: 25.0455, longitude: 121.5300 },
  { latitude: 25.0440, longitude: 121.5380 },
  { latitude: 25.0430, longitude: 121.5430 },
  { latitude: 25.0420, longitude: 121.5480 },
  { latitude: 25.0413, longitude: 121.5550 },
  { latitude: 25.0409, longitude: 121.5600 },
  { latitude: 25.0405, longitude: 121.5650 },
  { latitude: 25.0380, longitude: 121.5648 },
  { latitude: 25.0360, longitude: 121.5646 },
  { latitude: 25.1000, longitude: 121.4800 },
];

export const mockConvenienceStoresTaipei = [
  { latitude: 25.0472, longitude: 121.5190, store_type: "7-Eleven" },
  { latitude: 25.0462, longitude: 121.5260, store_type: "FamilyMart" },
  { latitude: 25.0450, longitude: 121.5330, store_type: "7-Eleven" },
  { latitude: 25.0430, longitude: 121.5420, store_type: "Hi-Life" },
  { latitude: 25.0418, longitude: 121.5490, store_type: "7-Eleven" },
  { latitude: 25.0411, longitude: 121.5570, store_type: "FamilyMart" },
  { latitude: 25.0407, longitude: 121.5630, store_type: "7-Eleven" },
  { latitude: 25.0370, longitude: 121.5647, store_type: "OK Mart" },
  { latitude: 25.1100, longitude: 121.4700, store_type: "7-Eleven" },
];
