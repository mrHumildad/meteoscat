import { safeAvg } from './utils.js';

export const computeGeoValues = (stationsGeo, data, daysInRange) => {
    if (!stationsGeo || !Array.isArray(stationsGeo.features)) return null;
    
    const features = stationsGeo.features.map(f => {
      const code = f.properties?.codi;
      
      if (code && daysInRange.length) {
        let temperatures = [];
        let humidities = [];
        let precAcc = 0;
        
        for (const dayKey of daysInRange) {
          // Check if data exists for the day and station before accessing
          const stationData = data[dayKey]?.[code] 
          
          if (stationData) {
            precAcc += stationData.precAcc ?? 0;
            temperatures.push(stationData.tempAvg);
            humidities.push(stationData.humAvg);
          }
        }

        const temperatureAvg = safeAvg(temperatures);
        const humidityAvg = safeAvg(humidities);
        const precipAccumRounded = precAcc === null ? null : Math.round(precAcc * 10) / 10;
        const temperatureAvgRounded = temperatureAvg === null ? null : Math.round(temperatureAvg * 10) / 10;
        const humidityAvgRounded = humidityAvg === null ? null : Math.round(humidityAvg * 10) / 10;
        //console.log(`Station ${code}: precAcc=${precipAccumRounded}, tempAvg=${temperatureAvgRounded}, humAvg=${humidityAvgRounded}`);
        return {
          ...f,
          properties: {
            ...f.properties,
            precAcc: precipAccumRounded,
            tempAvg: temperatureAvgRounded,
            humAvg: humidityAvgRounded,
          }
        };
      }
      // Return the feature unchanged if no data or no days selected
      return f;
    });

    return { type: 'FeatureCollection', features };
  };