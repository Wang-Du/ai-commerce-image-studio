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

function sameTask(left, right) {
  return ['id', 'type', 'ratio', 'width', 'height', 'quantity'].every((key) => left[key] === right[key])
    && String(left.prompt || '') === String(right.prompt || '')
}

// Jobs are newest first. A task ID alone is not enough: the user may have edited it or changed products.
export function reconcileBackgroundJobs({ tasks, assetId, jobs, results = [], failures = [] }) {
  let nextResults = [...results]
  let nextFailures = [...failures]
  const nextTasks = tasks.map((task) => {
    const job = jobs.find((item) => item.assetId === assetId && item.tasks.some((saved) => sameTask(saved, task)))
    if (!job) return task
    const outputs = (job.results || []).filter((item) => item.taskId === task.id)
    const errors = (job.failures || []).filter((item) => item.taskId === task.id)
    nextResults = [...nextResults.filter((item) => item.taskId !== task.id), ...outputs]
    nextFailures = [...nextFailures.filter((item) => item.taskId !== task.id), ...errors]
    const progress = Math.round((outputs.length + errors.length) / task.quantity * 100)
    const status = job.status === 'queued' ? 'queued' : job.status === 'running' ? 'generating'
      : outputs.length >= task.quantity ? 'done' : outputs.length ? 'partial' : 'error'
    return { ...task, status, progress }
  })
  return { tasks: nextTasks, results: nextResults, failures: nextFailures }
}
