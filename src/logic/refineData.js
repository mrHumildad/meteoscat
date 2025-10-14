import raw from '../../full_dades.json'
import stations from '../../stations.json'

const values = {
  "temperatura": [], 
  "humitat": [], 
  "precipitacio": [],
  "velocitatVent": [],
  "direccioVent": [],
  "alturaSensorVent": [],
  "ratxaMaximaVent": [],
  "direccioRatxaMaximaVent":[]
}

export const refineData = () => {
  let refinedData = {}
  const days = Object.keys(raw)
  days.forEach(day => {
    refinedData[day] = {}
    stations.forEach(station => {
      refinedData[day][station.codi] = {
        temperatura: [],
        humitat: [],
        precipitacio: [],
        velocitatVent: [],
        direccioVent: [],
        alturaSensorVent: [],
        ratxaMaximaVent: [],
        direccioRatxaMaximaVent: []
      }
    })
    const hours = Object.keys(raw[day])
    hours.forEach(hour => {
      const stationsData = Object.keys(raw[day][hour])
      stationsData.forEach(stationData => {
        const stationValues = Object.keys(raw[day][hour][stationData])
        stationValues.forEach(stationValue => {
          if(refinedData[day][stationData] && raw[day][hour][stationData][stationValue] !== null) {
            refinedData[day][stationData][stationValue].push(raw[day][hour][stationData][stationValue])
          }
        })
      })

    }) 
  })
  return refinedData
}