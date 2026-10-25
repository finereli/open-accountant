import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { updates } from '$shared/lib/updates.svelte'

updates.init()

export default mount(App, { target: document.getElementById('app')! })
