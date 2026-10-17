import { describe, expect, it } from 'vitest'
import { clampInterval, isAllowedOrigin, isSameOrigin, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS } from './http.js'

describe('clampInterval', () => {
  it('defaults when missing or junk', () => {
    expect(clampInterval(undefined)).toBe(DEFAULT_INTERVAL_MS)
    expect(clampInterval('abc')).toBe(DEFAULT_INTERVAL_MS)
    expect(clampInterval(null)).toBe(DEFAULT_INTERVAL_MS)
    expect(clampInterval(Infinity)).toBe(DEFAULT_INTERVAL_MS)
  })
  it('clamps to [5s, 60s]', () => {
    expect(clampInterval(1)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(0)).toBe(MIN_INTERVAL_MS)
    expect(clampInterval(10_000_000)).toBe(MAX_INTERVAL_MS)
    expect(clampInterval(15000)).toBe(15000)
  })
})

describe('isAllowedOrigin', () => {
  it('allows the local UI and no-Origin callers', () => {
    expect(isAllowedOrigin(undefined)).toBe(true)
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe(true)
  })
  it('rejects other sites and ports', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false)
    expect(isAllowedOrigin('http://localhost.evil.example:3000')).toBe(false)
    expect(isAllowedOrigin('null')).toBe(false)
  })
})

describe('isSameOrigin', () => {
  it('matches the origin against the Host header, port included', () => {
    expect(isSameOrigin('https://wargames.example', 'wargames.example')).toBe(true)
    expect(isSameOrigin('http://localhost:3005', 'localhost:3005')).toBe(true)
    expect(isSameOrigin('http://localhost:3005', 'localhost:3001')).toBe(false)
    expect(isSameOrigin('https://evil.example', 'wargames.example')).toBe(false)
    expect(isSameOrigin(undefined, 'wargames.example')).toBe(false)
    expect(isSameOrigin('null', 'wargames.example')).toBe(false)
  })
})
