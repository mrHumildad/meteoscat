import raw from '../../full_dades.json'
import stations from '../../stations.json'

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
        // reserve calcs space (will compute later)
        calcs: {}
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

      s.calcs = {
        temperatura: {
          average: safeAvg(s.temperatura),
          min: safeMin(s.temperatura),
          max: safeMax(s.temperatura)
        },
        humitat: {
          average: safeAvg(s.humitat),
          min: safeMin(s.humitat),
          max: safeMax(s.humitat)
        },
        precipitacio: {
          total: safeMax(s.precipitacio)
        },
/*         velocitatVent: {
          average: safeAvg(s.velocitatVent),
          min: safeMin(s.velocitatVent),
          max: safeMax(s.velocitatVent)
        }, */
        // add other calcs as needed
      }
    })
  })
  console.log('Refined data ready', refinedData)

  return refinedData
}