const DEFAULT_PROGRESS_STEPS = [12, 38, 67, 88, 100]

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class MockImageGenerator {
  constructor({ delay = () => wait(220), shouldFail = () => false } = {}) {
    this.delay = delay
    this.shouldFail = shouldFail
  }

  async generate(task, onProgress) {
    for (const progress of DEFAULT_PROGRESS_STEPS) {
      await this.delay()
      onProgress(progress)
    }

    if (this.shouldFail(task)) {
      throw new Error('演示生成失败，请单独重试该任务')
    }

    return Array.from({ length: task.quantity }, (_, index) => ({
      id: `${task.id}-result-${index + 1}`,
      taskId: task.id,
      index,
      createdAt: new Date().toISOString(),
    }))
  }
}
