import * as echarts from 'echarts/core';
import { BoxplotChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * ECharts 按需注册（echarts/core 树摇，控制包体积）。
 * 大数据曲线关键配置见各组件：sampling:'lttb' / large:true / progressive / animation:false
 * （方案 §5.1 / §8.3）。
 */
echarts.use([
  LineChart,
  BoxplotChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  BrushComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

export { echarts };
