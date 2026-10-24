import { describe, expect, it } from 'vitest'
import { makeTaskFailure, sanitizeFailureDetail, validTaskFailure } from '../../src/shared/task-failure.ts'

describe('task failure catalog', () => {
  it('maps model transport facts to stable actions', () => {
    expect(makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { httpStatus: 401 } })).toMatchObject({ family: 'MODEL_AUTH', action: 'open_model_settings', retryable: false })
    expect(makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { httpStatus: 429, retryAfterMs: 2000 } })).toMatchObject({ family: 'MODEL_RATE_LIMIT', action: 'retry', retryable: true })
    expect(makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { httpStatus: 503 } })).toMatchObject({ family: 'MODEL_UNAVAILABLE', action: 'retry', retryable: true })
    expect(makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { networkCode: 'ENOTFOUND' } })).toMatchObject({ family: 'NETWORK', action: 'open_network_settings' })
  })

  it('maps local families without guessing a provider failure', () => {
    expect(makeTaskFailure({ code: 'MODEL_CONTEXT_LIMIT', diagnosticId: 'd' })).toMatchObject({ family: 'MODEL_CONTEXT', retryable: false })
    expect(makeTaskFailure({ code: 'MODEL_PROTOCOL_ERROR', diagnosticId: 'd' })).toMatchObject({ family: 'MODEL_PROTOCOL', retryable: false })
    expect(makeTaskFailure({ code: 'LEDGER_OWNERSHIP_UNVERIFIED', diagnosticId: 'd' })).toMatchObject({ family: 'LEDGER', action: 'repair_ledger' })
    expect(makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { httpStatus: 400 } })).toMatchObject({ family: 'INTERNAL', retryable: false })
  })

  it('drops non-allowlisted and control-character details', () => {
    expect(sanitizeFailureDetail({ httpStatus: 429, secret: 'x', sdkType: 'AI_APICallError', networkCode: '\u0001', providerCode: 1 })).toEqual({ httpStatus: 429, sdkType: 'AI_APICallError', providerCode: 1 })
  })

  it('falls back for an unbounded or control-character error code', () => {
    expect(makeTaskFailure({ code: 'x'.repeat(200), diagnosticId: 'd' }).code).toBe('INTERNAL')
    expect(makeTaskFailure({ code: 'bad\u0001code', diagnosticId: 'd' }).code).toBe('INTERNAL')
  })

  it('validates the persisted shape', () => {
    const failure = makeTaskFailure({ code: 'MODEL_REQUEST_FAILED', diagnosticId: 'd', detail: { httpStatus: 503 } })
    expect(validTaskFailure(failure)).toBe(true)
    expect(validTaskFailure({ ...failure, detail: { arbitrary: true } })).toBe(false)
    expect(validTaskFailure({ ...failure, family: 'NOT_A_FAMILY' })).toBe(false)
  })
})
