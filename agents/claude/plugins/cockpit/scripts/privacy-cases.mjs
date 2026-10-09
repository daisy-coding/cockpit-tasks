// Общий набор примеров используется тестом мода и сравнением с Python.
import { redactRawSecrets, redactSecrets } from '../hooks/domain/privacy.ts'
import { PRIVACY_CASES } from '../tests/privacy-fixtures.ts'

process.stdout.write(JSON.stringify(PRIVACY_CASES.map(example => ({ ...example, actual: redactRawSecrets(example.text), viewActual: redactSecrets(example.text) }))))
