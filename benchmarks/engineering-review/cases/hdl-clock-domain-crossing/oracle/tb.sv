module tb;
  logic dst_clk = 1'b0;
  logic async_level = 1'b0;
  logic synced_level;
  level_sync dut(.*);
  always #5 dst_clk = ~dst_clk;
  initial begin
    repeat (3) @(posedge dst_clk);
    #1; if (synced_level !== 1'b0) $fatal(1, "failed to settle low");
    async_level = 1'b1;
    @(posedge dst_clk); #1;
    if (synced_level !== 1'b0) $fatal(1, "input crossed in one stage");
    @(posedge dst_clk); #1;
    if (synced_level !== 1'b1) $fatal(1, "two-stage output did not update");
    $finish;
  end
endmodule
