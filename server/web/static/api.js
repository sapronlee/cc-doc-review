// 带令牌的接口调用；失败时抛出服务端返回的错误文本。

export function createApi(token) {
  async function send(method, url, body) {
    const headers = { 'X-Review-Token': token }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }
  return { get: url => send('GET', url), send }
}
