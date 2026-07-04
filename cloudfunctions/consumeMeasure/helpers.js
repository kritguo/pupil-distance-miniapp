function chooseConsumeSource({ annualActive, alreadyUnlocked, retestCredits, remainCount, preferPaid }) {
  if (annualActive) return 'annual'
  if (alreadyUnlocked) return 'already_unlocked'
  if (preferPaid) {
    return remainCount > 0 ? 'paid' : 'none'
  }
  if (retestCredits > 0) return 'retest'
  if (remainCount > 0) return 'paid'
  return 'none'
}

module.exports = {
  chooseConsumeSource
}
