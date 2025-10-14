export const getAverage = (arr) => {
  const sum = arr.reduce((acc, val) => acc + val, 0)
  return (sum / arr.length).toFixed(2)
}

export const formatNumber = v =>
  typeof v === 'number' && isFinite(v) ? v.toFixed(2) : '-'

export const toNumberSafe = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}