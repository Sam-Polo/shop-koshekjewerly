import { describe, expect, it } from 'vitest'
import { isTildaPickupInNew, PIPELINE_ID, STAGE_NEW, ENUM_TELEGRAM, ENUM_MAX, ENUM_TILDA } from './amocrm-lead-processor.js'

function makeLead(overrides: {
  pipelineId?: number
  statusId?: number
  sourceEnumId?: number
  delivery?: string
}) {
  const customFields: any[] = []
  if (overrides.delivery !== undefined) {
    customFields.push({ field_id: 774553, values: [{ value: overrides.delivery }] })
  }
  if (overrides.sourceEnumId !== undefined) {
    customFields.push({ field_id: 770993, values: [{ enum_id: overrides.sourceEnumId }] })
  }
  return {
    pipeline_id: overrides.pipelineId ?? PIPELINE_ID,
    status_id: overrides.statusId ?? STAGE_NEW,
    custom_fields_values: customFields,
  }
}

describe('isTildaPickupInNew', () => {
  it('routes a Tilda lead with explicit source enum', () => {
    const lead = makeLead({ sourceEnumId: ENUM_TILDA, delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(true)
  })

  it('routes a Tilda lead when the source field is missing (real-world mapping gap, lead 28304475)', () => {
    const lead = makeLead({ delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(true)
  })

  it('does not route our own Telegram bot leads sitting in «Новый»', () => {
    const lead = makeLead({ sourceEnumId: ENUM_TELEGRAM, delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(false)
  })

  it('does not route our own MAX bot leads sitting in «Новый»', () => {
    const lead = makeLead({ sourceEnumId: ENUM_MAX, delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(false)
  })

  it('leaves courier (non-pickup) leads alone', () => {
    const lead = makeLead({ delivery: 'Доставка СДЭК до пункта выдачи' })
    expect(isTildaPickupInNew(lead)).toBe(false)
  })

  it('is idempotent once the lead has already moved out of «Новый»', () => {
    const lead = makeLead({ statusId: 86584502, delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(false)
  })

  it('ignores leads outside our pipeline', () => {
    const lead = makeLead({ pipelineId: 1, delivery: 'Самовывоз из мастерской (г.Москва)' })
    expect(isTildaPickupInNew(lead)).toBe(false)
  })
})
