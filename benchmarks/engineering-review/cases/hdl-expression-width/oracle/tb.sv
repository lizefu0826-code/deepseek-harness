module tb;
  logic [7:0] a;
  logic [7:0] b;
  logic [8:0] sum;
  wide_sum dut(.*);
  initial begin
    a = 8'hff; b = 8'h01; #1;
    if (sum !== 9'h100) $fatal(1, "carry was lost");
    a = 8'hff; b = 8'hff; #1;
    if (sum !== 9'h1fe) $fatal(1, "full-width sum was lost");
    $finish;
  end
endmodule
