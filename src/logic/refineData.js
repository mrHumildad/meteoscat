import raw from '../../public/logic/full_dades.json'
import stations from './stations.json'

/* const values = {
  "temperatura": [], 
  "humitat": [], 
  "precipitacio": [],
  "velocitatVent": [],
  "direccioVent": [],
  "alturaSensorVent": [],
  "ratxaMaximaVent": [],
  "direccioRatxaMaximaVent":[]
} */

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
        direccioRatxaMaximaVent: [],

      }
    })
    const hours = Object.keys(raw[day] || {})
    hours.forEach(hour => {
      const stationsData = Object.keys(raw[day][hour] || {})
      stationsData.forEach(stationData => {
        const stationValues = Object.keys(raw[day][hour][stationData] || {})
        stationValues.forEach(stationValue => {
          if (refinedData[day][stationData] && raw[day][hour][stationData][stationValue] !== null) {
            refinedData[day][stationData][stationValue].push(raw[day][hour][stationData][stationValue])
          }
        })
      })
    })

    // compute calcs AFTER all hours processed
    Object.keys(refinedData[day]).forEach(stCode => {
      const s = refinedData[day][stCode]

      const safeAvg = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return null
        const sum = arr.reduce((a, b) => a + Number(b), 0)
        return parseFloat((sum / arr.length).toFixed(1))
      }
      const safeMin = arr => (Array.isArray(arr) && arr.length ? Math.min(...arr) : null)
      const safeMax = arr => (Array.isArray(arr) && arr.length ? Math.max(...arr) : null)
      const safeSum = arr => (Array.isArray(arr) && arr.length ? arr.reduce((a, b) => a + b, 0) : 0)

      
      s.tempAvg = safeAvg(s.temperatura),
      s.tempMin = safeMin(s.temperatura),
      s.tempMax = safeMax(s.temperatura)


      s.humAvg = safeAvg(s.humitat),
      s.humMin = safeMin(s.humitat),
      s.humMax = safeMax(s.humitat)

      s.precAcc = safeMax(s.precipitacio)
/*         velocitatVent: {
          average: safeAvg(s.velocitatVent),
          min: safeMin(s.velocitatVent),
          max: safeMax(s.velocitatVent)
        }, */
        // add other calcs as needed
      
    })
  })
  //calculate global stat for each day
  refinedData = Object.fromEntries(
    Object.entries(refinedData).map(([day, stationsData]) => {
      const dayStats = {
        tempAvg: null,
        tempMin: null,
        tempMax: null,
        humAvg: null,
        humMin: null,
        humMax: null,
        precAcc: 0
      }
      const tempAvgs = []
      const tempMins = []
      const tempMaxs = []
      const humAvgs = []
      const humMins = []
      const humMaxs = []
      const precAccs = []

      Object.values(stationsData).forEach(s => {
        if (s.tempAvg !== null) tempAvgs.push(s.tempAvg)
        if (s.tempMin !== null) tempMins.push(s.tempMin)
        if (s.tempMax !== null) tempMaxs.push(s.tempMax)
        if (s.humAvg !== null) humAvgs.push(s.humAvg)
        if (s.humMin !== null) humMins.push(s.humMin)
        if (s.humMax !== null) humMaxs.push(s.humMax)
        if (s.precAcc !== null) precAccs.push(s.precAcc)
      })

      const safeAvg = arr => {
        if (!Array.isArray(arr) || arr.length === 0) return null
        const sum = arr.reduce((a, b) => a + Number(b), 0)
        return parseFloat((sum / arr.length).toFixed(1))
      }

      dayStats.tempAvg = safeAvg(tempAvgs)
      dayStats.tempMin = tempMins.length ? Math.min(...tempMins) : null
      dayStats.tempMax = tempMaxs.length ? Math.max(...tempMaxs) : null

      dayStats.humAvg = safeAvg(humAvgs)
      dayStats.humMin = humMins.length ? Math.min(...humMins) : null
      dayStats.humMax = humMaxs.length ? Math.max(...humMaxs) : null

      dayStats.precMin = 0
      dayStats.precMax = precAccs.length ? Math.max(...precAccs) : null
      dayStats.precAcc = precAccs.length ? precAccs.reduce((a, b) => a + b, 0) : 0

      return [day, { ...stationsData, dayStats }]
    })
  )
  console.log('Refined data ready', refinedData)

  return refinedData
}