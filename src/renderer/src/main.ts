import './styles.css'
import { start } from './shell.ts'

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')
void start(root)
