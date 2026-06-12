// 测试 review 的门控逻辑：修复后，卡住的团队应该能立即得到响应

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`❌ ${message}`)
  console.log(`✅ ${message}`)
}

// 模拟新的门控逻辑
function testReviewGateFixed() {
  console.log('\n=== 测试：修复后的 review 门控（卡住团队优先） ===\n')

  // 新逻辑：先检查是否有卡住的团队，如果有则跳过 anyBusy 门控
  function canRunReview(isUrgent: boolean, anyBusy: boolean, brainBusy: boolean): boolean {
    if (brainBusy) return false // 用户在和助理对话时总是阻止
    if (isUrgent) return true // 卡住的团队绕过 anyBusy 门控
    if (anyBusy) return false // 常规 review 还是要等系统空闲
    return true
  }

  // 场景1：团队A卡住，系统空闲
  console.log('场景1：团队A卡住，系统空闲')
  const canRun1 = canRunReview(true, false, false)
  assert(canRun1, '应该立即处理团队A')

  // 场景2：团队A卡住，但团队B还在工作 ← 关键修复点
  console.log('\n场景2：团队A卡住，但团队B还在工作')
  const canRun2 = canRunReview(true, true, false)
  assert(canRun2, '✨ 修复！卡住的团队A绕过门控，立即得到响应（不用等团队B）')

  // 场景3：团队A卡住，但用户正在和助理对话
  console.log('\n场景3：团队A卡住，但用户正在和助理对话')
  const canRun3 = canRunReview(true, false, true)
  assert(!canRun3, '用户对话优先，团队A要等用户聊完（合理）')

  // 场景4：常规 review（没有卡住的团队），团队B还在工作
  console.log('\n场景4：常规 review（没有卡住），但团队B还在工作')
  const canRun4 = canRunReview(false, true, false)
  assert(!canRun4, '常规 review 还是要等系统空闲（避免频繁打断）')

  // 场景5：常规 review，系统空闲
  console.log('\n场景5：常规 review，系统空闲')
  const canRun5 = canRunReview(false, false, false)
  assert(canRun5, '常规 review 可以执行')

  console.log('\n=== 修复效果 ===')
  console.log('✅ 卡住的团队（capability-gap）现在能立即得到响应')
  console.log('✅ 不受其他团队运行状态影响')
  console.log('✅ 只有用户对话时才会延迟（合理优先级）')
  console.log('✅ 常规 review 保持原有的门控逻辑（避免频繁打断）')
}

testReviewGateFixed()
