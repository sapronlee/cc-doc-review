/** 重画信号的计数。*/
export type Redraws = number

declare module 'claude-code' {
  interface PluginState {
    'cc-doc-review': {
      /** 每次回复区要重画（回复、按钮状态变了）就加一；回复区绘制时读它，写入后桌面版会重画读过它的地方。*/
      redraws: Redraws
      /** 回车发出的消息记下完整内容的次数；聊天记录里的消息读它，记下后重画，画出回复卡片。*/
      sentMarks: number
    }
  }
}
