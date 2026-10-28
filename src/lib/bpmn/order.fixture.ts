// "Đơn hàng" sample as BPMN: customer, system, warehouse, accounting lanes.
export const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="P" name="Đơn hàng">
    <bpmn:laneSet>
      <bpmn:lane id="L1" name="Khách hàng"><bpmn:flowNodeRef>s</bpmn:flowNodeRef><bpmn:flowNodeRef>a</bpmn:flowNodeRef><bpmn:flowNodeRef>r</bpmn:flowNodeRef><bpmn:flowNodeRef>e1</bpmn:flowNodeRef><bpmn:flowNodeRef>e2</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="L2" name="Hệ thống"><bpmn:flowNodeRef>b</bpmn:flowNodeRef><bpmn:flowNodeRef>g</bpmn:flowNodeRef><bpmn:flowNodeRef>n</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="L3" name="Kho"><bpmn:flowNodeRef>c</bpmn:flowNodeRef><bpmn:flowNodeRef>d</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="L4" name="Kế toán"><bpmn:flowNodeRef>i</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="s" name="Bắt đầu"/>
    <bpmn:userTask id="a" name="Đặt hàng trên website"/>
    <bpmn:serviceTask id="b" name="Kiểm tra tồn kho"/>
    <bpmn:exclusiveGateway id="g" name="Còn hàng?"/>
    <bpmn:parallelGateway id="p1" name="Tách"/>
    <bpmn:userTask id="c" name="Soạn hàng"/>
    <bpmn:userTask id="i" name="Xuất hóa đơn"/>
    <bpmn:parallelGateway id="p2" name="Gộp"/>
    <bpmn:userTask id="d" name="Giao hàng"/>
    <bpmn:userTask id="r" name="Nhận hàng"/>
    <bpmn:serviceTask id="n" name="Báo hết hàng"/>
    <bpmn:endEvent id="e1" name="Đã giao"/>
    <bpmn:endEvent id="e2" name="Hủy đơn"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a"/>
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="b"/>
    <bpmn:sequenceFlow id="f3" sourceRef="b" targetRef="g"/>
    <bpmn:sequenceFlow id="f4" sourceRef="g" targetRef="p1" name="Có"/>
    <bpmn:sequenceFlow id="f5" sourceRef="g" targetRef="n" name="Hết hàng"/>
    <bpmn:sequenceFlow id="f6" sourceRef="p1" targetRef="c"/>
    <bpmn:sequenceFlow id="f7" sourceRef="p1" targetRef="i"/>
    <bpmn:sequenceFlow id="f8" sourceRef="c" targetRef="p2"/>
    <bpmn:sequenceFlow id="f9" sourceRef="i" targetRef="p2"/>
    <bpmn:sequenceFlow id="f10" sourceRef="p2" targetRef="d"/>
    <bpmn:sequenceFlow id="f11" sourceRef="d" targetRef="r"/>
    <bpmn:sequenceFlow id="f12" sourceRef="r" targetRef="e1"/>
    <bpmn:sequenceFlow id="f13" sourceRef="n" targetRef="e2"/>
  </bpmn:process>
</definitions>`;
