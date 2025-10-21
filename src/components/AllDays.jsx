import React, { useState, useMemo } from 'react'
import stations from '../../stations.json'
import { getAverage } from '../logic/utils'
import { formatNumber, toNumberSafe } from '../logic/utils'
import Map from '@vis.gl/react-maplibre'


const AllDays = ({data}) => {
  const days = Object.keys(data)
  const [valueShowed, setValueShowed] = useState('temperatura')
  const [startIndex, setStartIndex] = useState(0)
  const [endIndex, setEndIndex] = useState(days.length - 1)

  // 🧮 Get only the days in the selected range
  const selectedDays = days.slice(startIndex, endIndex + 1)

  // 🧮 Compute averages/totals for selected range
  const { stationAverages, rangeAverages } = useMemo(() => {
    const stationAverages = {}
    const rangeAverages = {}
    const stationsList = Object.keys(data[days[0]] || {})

    stationsList.forEach(station => {
      const valuesInRange = []
      stationAverages[station] = {}

      selectedDays.forEach(day => {
        const dayStation = data[day]?.[station]
        const avg = dayStation ? getAverage(dayStation[valueShowed]) : NaN
        const safeVal = toNumberSafe(avg)
        stationAverages[station][day] = safeVal
        if (!isNaN(safeVal)) valuesInRange.push(safeVal)
      })

      // 📊 Calculate overall for range
      rangeAverages[station] =
        valueShowed === 'precipitacio'
          ? valuesInRange.reduce((a, b) => a + b, 0) // sum for rain
          : valuesInRange.length
          ? valuesInRange.reduce((a, b) => a + b, 0) / valuesInRange.length // avg otherwise
          : NaN
    })

    return { stationAverages, rangeAverages }
  }, [valueShowed, selectedDays])

  // 📊 Sort by range total/average descending
  const sortedStations = Object.keys(rangeAverages).sort(
    (a, b) => (rangeAverages[b] || -Infinity) - (rangeAverages[a] || -Infinity)
  )

  return (
    <div>
      <div >
        <button onClick={() => setValueShowed('temperatura')}>Temperatura</button>
        <button onClick={() => setValueShowed('precipitacio')}>Precipitació</button>
        <button onClick={() => setValueShowed('humitat')}>Humitat</button>
      </div>
      <Map data={data} valueShowed={valueShowed} selectedDays={selectedDays} />
      {/* 🗓️ Range selectors */}
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
            <th>
              {valueShowed === 'precipitacio'
                ? 'Total pluja (ml)'
                : `Mitjana (${valueShowed})`}
            </th>
            {selectedDays.map(day => (
              <th className="vert-text" key={day}>
                {day}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {sortedStations.map(station => {
            const stationName =
              stations.find(s => s.codi === station)?.nom || station
            const overall = rangeAverages[station]

            return (
              <tr key={station}>
                <td>{stationName}</td>
                <td style={{ fontWeight: 'bold' }}>
                  {formatNumber(overall)}
                </td>
                {selectedDays.map(day => {
                  const val = stationAverages[station]?.[day]
                  return <td key={day}>{formatNumber(val)}</td>
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default AllDays
