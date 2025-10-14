import React, { useState, useMemo } from 'react'
import stations from '../../stations.json'
import { getAverage, formatNumber, toNumberSafe } from '../logic/utils'
import { refineData } from '../logic/refineData'

const data = refineData()
const days = Object.keys(data)

const Filter = () => {
  const [startIndex, setStartIndex] = useState(0)
  const [endIndex, setEndIndex] = useState(days.length - 1)
  const [filter, setFilter] = useState({
    tempMin: -100,
    tempMax: 100,
    rainMin: 0,
    rainMax: 1000000,
    humMin: 0,
    humMax: 100,
  })

  const selectedDays = days.slice(startIndex, endIndex + 1)

  // Compute averages/totals for all three metrics for selected range
  const stationsData = useMemo(() => {
    const results = {}
    Object.keys(data[days[0]] || {}).forEach(station => {
      let temps = []
      let rains = []
      let hums = []

      selectedDays.forEach(day => {
        const dayStation = data[day]?.[station]
        if (dayStation) {
          const t = toNumberSafe(getAverage(dayStation.temperatura))
          const r = toNumberSafe(getAverage(dayStation.precipitacio))
          const h = toNumberSafe(getAverage(dayStation.humitat))
          if (!isNaN(t)) temps.push(t)
          if (!isNaN(r)) rains.push(r)
          if (!isNaN(h)) hums.push(h)
        }
      })

      results[station] = {
        tempAvg: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : NaN,
        rainTotal: rains.length ? rains.reduce((a, b) => a + b, 0) : NaN,
        humAvg: hums.length ? hums.reduce((a, b) => a + b, 0) / hums.length : NaN,
        temps,
        rains,
        hums,
      }
    })
    return results
  }, [selectedDays])

  // Filter stations according to filter object
  const filteredStations = Object.keys(stationsData).filter(station => {
    const s = stationsData[station]
    return (
      s.tempAvg >= filter.tempMin &&
      s.tempAvg <= filter.tempMax &&
      s.rainTotal >= filter.rainMin &&
      s.rainTotal <= filter.rainMax &&
      s.humAvg >= filter.humMin &&
      s.humAvg <= filter.humMax
    )
  })

  return (
    <div>
      <div style={{ marginBottom: '10px', display: 'flex', gap: '10px', flexDirection: 'column', alignItems: 'center' }}>
        <label> temp min </label>
        <input
          type="number"
          value={filter.tempMin}
          onChange={e => setFilter({ ...filter, tempMin: Number(e.target.value) })}
          placeholder="Temp mín"
        />
        <label> temp max </label>
        <input
          type="number"
          value={filter.tempMax}
          onChange={e => setFilter({ ...filter, tempMax: Number(e.target.value) })}
          placeholder="Temp màx"
        />
        <label> rain min </label>
        <input
          type="number"
          value={filter.rainMin}
          onChange={e => setFilter({ ...filter, rainMin: Number(e.target.value) })}
          placeholder="Pluja mín (mm)"
        />
        <label> rain max </label>
        <input
          type="number"
          value={filter.rainMax}
          onChange={e => setFilter({ ...filter, rainMax: Number(e.target.value) })}
          placeholder="Pluja màx (mm)"
        />
        <label> hum min </label>
        <input
          type="number"
          value={filter.humMin}
          onChange={e => setFilter({ ...filter, humMin: Number(e.target.value) })}
          placeholder="Humitat mín (%)"
        />
        <label> hum max </label>
        <input
          type="number"
          value={filter.humMax}
          onChange={e => setFilter({ ...filter, humMax: Number(e.target.value) })}
          placeholder="Humitat màx (%)"
        />
      </div>

      {/* Range selectors */}
      <div style={{ marginBottom: '15px' }}>
        <label>
          Inici:{' '}
          <select
            value={startIndex}
            onChange={e => {
              const newStart = Number(e.target.value)
              if (newStart <= endIndex) setStartIndex(newStart)
            }}
          >
            {days.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        </label>

        <label style={{ marginLeft: '10px' }}>
          Fi:{' '}
          <select
            value={endIndex}
            onChange={e => {
              const newEnd = Number(e.target.value)
              if (newEnd >= startIndex) setEndIndex(newEnd)
            }}
          >
            {days.map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        </label>

        <span style={{ marginLeft: '10px' }}>
          Dies seleccionats: {selectedDays.length}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Estació</th>
            <th>Mitjana Temp</th>
            <th>Total Pluja</th>
            <th>Mitjana Humitat</th>

          </tr>
        </thead>

        <tbody>
          {filteredStations.map(station => {
            const sData = stationsData[station]
            const stationName = stations.find(s => s.codi === station)?.nom || station
            return (
              <tr key={station}>
                <td>{stationName}</td>
                <td>{formatNumber(sData.tempAvg)}</td>
                <td>{formatNumber(sData.rainTotal)}</td>
                <td>{formatNumber(sData.humAvg)}</td>
                
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default Filter
