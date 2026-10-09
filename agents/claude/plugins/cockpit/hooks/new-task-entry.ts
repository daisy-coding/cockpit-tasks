type NewTaskEntryState = { tab: string; adding: boolean; readOnly: boolean; page: unknown; emptyAgentList?: boolean }

// Пустой список открывает тот же редактор, что плюс; режим чтения и страница задачи поля не получают.
export function newTaskEntryVisible(state: NewTaskEntryState): boolean {
  return state.tab === 'agent' && !state.readOnly && !state.page && (state.adding || state.emptyAgentList === true)
}
