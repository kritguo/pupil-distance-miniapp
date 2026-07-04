const test = require('node:test')
const assert = require('node:assert/strict')

const { chooseConsumeSource } = require('../cloudfunctions/consumeMeasure/helpers.js')

test('uses retest credits before paid quota by default', () => {
  assert.equal(chooseConsumeSource({
    annualActive: false,
    alreadyUnlocked: false,
    retestCredits: 1,
    remainCount: 1,
    preferPaid: false
  }), 'retest')
})

test('uses newly purchased quota before retest credits when requested', () => {
  assert.equal(chooseConsumeSource({
    annualActive: false,
    alreadyUnlocked: false,
    retestCredits: 1,
    remainCount: 1,
    preferPaid: true
  }), 'paid')
  assert.equal(chooseConsumeSource({
    annualActive: false,
    alreadyUnlocked: false,
    retestCredits: 1,
    remainCount: 0,
    preferPaid: true
  }), 'none')
})
