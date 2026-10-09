import { expect, test } from 'claude-code/testing'
import { isHumanSurfaceCommand } from '../hooks/domain/rpc'

test('Heredoc с упоминанием рантайма проверяется целиком, вызов записи запрещён', () => {
  expect(isHumanSurfaceCommand("cat > /tmp/x.md <<'EOF'\nПроза с упоминанием cockpitctl.\nEOF")).toBe(true)
  expect(isHumanSurfaceCommand("cockpitctl rpc <<'EOF'\n{}\nEOF")).toBe(true)
})

test('Ложный heredoc в кавычках и комментариях не прячет вызов рантайма', () => {
  expect(isHumanSurfaceCommand('echo "<<EOF"\ncockpitctl rpc')).toBe(true)
  expect(isHumanSurfaceCommand('# <<EOF\ncockpitctl rpc')).toBe(true)
  expect(isHumanSurfaceCommand("cat > /tmp/x.md <<'EOF'\nПроза cockpitctl\nEOF\ncockpitctl rpc")).toBe(true)
  expect(isHumanSurfaceCommand('cat > /tmp/x.md <<-"EOF"\n\tcockpitctl в прозе\n\tEOF')).toBe(true)
  expect(isHumanSurfaceCommand('cockpitctl status | cat')).toBe(true)
})

test('Тело heredoc, которое исполняет оболочка или интерпретатор, остаётся кодом', () => {
  expect(isHumanSurfaceCommand("bash <<'EOF'\ncockpitctl rpc\nEOF")).toBe(true)
  expect(isHumanSurfaceCommand('cat <<EOF | sh\ncockpitctl rpc\nEOF')).toBe(true)
  expect(isHumanSurfaceCommand('python3 - <<PY\nimport subprocess; subprocess.run(["cockpitctl", "rpc"])\nPY')).toBe(true)
})

for (const command of [
  "cat > /tmp/x.md <<EOF\nПроза с упоминанием cockpitctl.\nEOF",
  "cat <<'EOF' | sh\ncockpitctl rpc\nEOF",
  "/usr/bin/python3 - <<'PY'\nimport subprocess; subprocess.run(['cockpitctl', 'rpc'])\nPY",
  "./run.sh <<'EOF'\ncockpitctl rpc\nEOF",
  "awk <<'EOF'\ncockpitctl rpc\nEOF",
  "cat > /tmp/x.md <<'EOF'\nПроза cockpitctl\nEOF\necho готово",
  "cat > /tmp/x.md <<'EOF'; echo готово\nПроза cockpitctl\nEOF",
  "cat > /tmp/x.md <<'EOF'\nПроза cockpitctl без закрывающей метки",
  "cat > /tmp/x.md <<'EOF'\nEOF\ncockpitctl rpc\nEOF",
  "cat > /tmp/x.md <<'EOF' <<'MORE'\nПроза cockpitctl\nEOF\nMORE",
  "cat > /tmp/$(cockpitctl rpc).md <<'EOF'\nПроза\nEOF",
  "cat > /tmp/`cockpitctl rpc`.md <<'EOF'\nПроза\nEOF",
  "cat > /tmp/x.md <<'EOF' && true\nПроза cockpitctl\nEOF",
  "cat > agents/claude/cockpit/rpc.py <<'EOF'\nПроза\nEOF",
]) test('Небезопасный heredoc проверяется целиком: ' + command.split('\n')[0], () => {
  expect(isHumanSurfaceCommand(command)).toBe(true)
})

for (const command of [
  "cat > /tmp/x.md <<'EOF'\nПроза с упоминанием cockpitctl.\nEOF",
  "cat <<'EOF' > /tmp/x.md\nПроза с упоминанием cockpitctl.\nEOF\n\n",
  'cat >> "/tmp/текст панели.md" <<-"EOF"\n\tcockpitctl в прозе\n\tEOF',
  "cat <<-'EOF' >> '/tmp/текст панели.md'\n\tcockpitctl в прозе\n\tEOF",
  "cat <<'EOF'\nПроза с упоминанием cockpitctl.\nEOF",
]) test('Тело heredoc не исключается из проверки даже для одиночной записи прозы: ' + command.split('\n')[0], () => {
  expect(isHumanSurfaceCommand(command)).toBe(true)
})

test('Команда без упоминания рантайма проходит и с heredoc', () => {
  expect(isHumanSurfaceCommand("cat > /tmp/x.md <<'EOF'\nОбычная проза.\nEOF")).toBe(false)
})

