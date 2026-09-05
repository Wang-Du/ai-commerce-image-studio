export function mergeTaskGenerationState(tasks, results = [], failures = []) {
  return tasks.map((task) => {
    const successCount = results.filter((result) => result.taskId === task.id).length
    const failureCount = failures.filter((failure) => failure.taskId === task.id).length
    if (successCount >= task.quantity) return { ...task, status: 'done', progress: 100 }
    if (successCount > 0) return { ...task, status: 'partial', progress: 100 }
    if (failureCount > 0) return { ...task, status: 'error', progress: 0 }
    return task
  })
}

export function beginTaskGeneration({ tasks, results = [], failures = [], taskIds = [] }) {
  const requestedIds = new Set(taskIds)
  return {
    tasks: tasks.map((task) => requestedIds.has(task.id)
      ? { ...task, status: 'generating', progress: 24 }
      : task),
    results: results.filter((result) => !requestedIds.has(result.taskId)),
    failures: failures.filter((failure) => !requestedIds.has(failure.taskId)),
  }
}
