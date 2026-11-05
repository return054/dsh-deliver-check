// dsh-deliver-check — DeepSeek Harness (DSH) 插件
// 文档: https://deepseek-harness.github.io/deepseek-harness/develop/basic/
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'deliver-check'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deliver_check',
    description: 'TODO: 一句话说明工具用途（会展示给模型）',
    parameters: {
      input: { type: 'string', required: true, description: 'TODO: 参数说明' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      // TODO: 换成真实实现
      return `echo: ${args.input}`
    },
  }))
}
