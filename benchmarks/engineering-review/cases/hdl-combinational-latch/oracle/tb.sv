module tb;
  logic valid;
  logic [7:0] data;
  logic [7:0] selected;
  packet_select dut(.*);
  initial begin
    valid = 1'b1; data = 8'ha5; #1;
    if (selected !== 8'ha5) $fatal(1, "valid selection failed");
    valid = 1'b0; data = 8'h3c; #1;
    if (selected !== 8'h00) $fatal(1, "invalid input retained prior value");
    $finish;
  end
endmodule
